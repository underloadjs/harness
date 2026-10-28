// Python half of syntaxCheck — parse a snippet without running it.
//
// Pipes the source to `compile()` through the interpreter, which also only parses.
// Requires a Python 3 interpreter on PATH; the lookup is cached after the first
// call. Loaded through `import()` by ./syntaxCheck only when the caller asks for
// language "python", so a JavaScript check never pays for node:child_process.
//
// Execution contract (R2): every child process is ASYNC and BOUNDED.
//   - the interpreter probe uses `spawn` with a timeout instead of spawnSync, so
//     a slow/hung interpreter cannot block the event loop (and therefore every
//     other tool or HTTP request in the harness);
//   - the check has a hard timeout and an abort path (context.signal), both of
//     which terminate the interpreter;
//   - stderr diagnostics are capped at 8 KiB through BoundedText, so a pathological
//     traceback cannot flood memory or the tool result.
//
// Verdict vs failure:
//   - exit code 0  -> true  (compile succeeded, nothing ran);
//   - exit code 1  -> false (SyntaxError from compile(); traceback on stderr);
//   - anything else (no interpreter, spawn error, signal, timeout, unexpected exit
//     code) -> HarnessError. "false" must mean "your code has a syntax error",
//     never "the checker could not run".
//
// Cross-references:
//   - ./syntaxCheck   — the public tool and its language dispatch
//   - ../catalogue    — metadata (name, description, tags, schema)
//   - ../command/boundedText — shared capped UTF-8 capture

import { spawn, type ChildProcess } from 'node:child_process';
import { HarnessError } from '../../util';
import { BoundedText } from '../command/boundedText';
import { terminateTree } from '../command/processTree';

// Interpreter candidates, in preference order. `python3` is the POSIX name;
// `python` is the Windows one. The Windows Store `python3` shim exists but exits
// non-zero, so the probe checks the exit status, not just that spawn succeeded.
const PYTHON_CANDIDATES = ['python3', 'python'] as const;

// `--version` answers in milliseconds; anything slower is a hung shim, not Python.
export const PYTHON_PROBE_TIMEOUT_MS = 5_000;

// Parsing source is fast. Ten seconds is generous for a cold interpreter start on
// a loaded machine and still bounded.
export const PYTHON_CHECK_TIMEOUT_MS = 10_000;

// Upper bound on captured interpreter diagnostics.
export const PYTHON_STDERR_MAX_BYTES = 8 * 1024;

// Parses only: `compile()` turns source into a code object without running it.
// Reading from stdin keeps the code out of the command line, where quoting and
// argument-length limits would otherwise bite.
//
// stdin is read from the BINARY buffer and decoded as UTF-8 explicitly. On
// Windows, `sys.stdin` text mode uses the locale codec (usually cp1252) for a
// pipe, which turned valid non-ASCII source such as `x = "😁"` into a decode
// error and a false "syntax" verdict. `-X utf8` + PYTHONUTF8 are belt-and-braces;
// the explicit decode is what removes the dependency on the host locale.
//
// Exit codes are a protocol, so only a real compile SyntaxError is a verdict:
//   0 -> valid syntax; 1 -> compile raised SyntaxError; 2 -> any other failure
//   (stdin decode, ValueError such as a NUL byte, unexpected exception). Node
//   treats 2 as an INFRASTRUCTURE error, never as "invalid syntax".
// Exported so the exit-code protocol can be tested with raw stdin bytes.
export const PYTHON_CHECK_SCRIPT = [
    'import sys',
    'import traceback',
    'try:',
    '    source = sys.stdin.buffer.read().decode("utf-8")',
    '    compile(source, "<harness>", "exec")',
    'except SyntaxError:',
    '    sys.exit(1)',
    'except BaseException:',
    '    traceback.print_exc()',
    '    sys.exit(2)'
].join('\n');

// undefined = not probed yet. The PROMISE is cached (not just the result) so two
// concurrent checks cannot run the probe twice; a rejected/resolved null is
// reused for the process lifetime, like the old synchronous cache.
let pythonInterpreter: Promise<string | null> | undefined;

// Run `<candidate> --version` with a timeout. Resolves false on spawn error,
// timeout, or non-zero exit (the Windows Store shim's behaviour).
const probe = (candidate: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
        let child: ChildProcess;

        try {
            child = spawn(candidate, ['--version'], {
                // Both streams are discarded: the answer is the exit status only.
                stdio: 'ignore',
                windowsHide: true
            });
        } catch {
            resolve(false);
            return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (available: boolean): void => {
            if (settled) return;

            settled = true;
            if (timer) clearTimeout(timer);
            resolve(available);
        };

        timer = setTimeout(() => {
            terminateTree(child);
            finish(false);
        }, PYTHON_PROBE_TIMEOUT_MS);

        child.on('error', () => finish(false));
        // `--version` on some builds writes to stderr and exits 0, so only the
        // status is consulted.
        child.on('close', (code) => finish(code === 0));
    });

// Find the first working interpreter, at most once per process.
const findPython = (): Promise<string | null> => {
    if (!pythonInterpreter) {
        pythonInterpreter = (async () => {
            for (const candidate of PYTHON_CANDIDATES) {
                if (await probe(candidate)) return candidate;
            }

            return null;
        })();
    }

    return pythonInterpreter;
};

// Append bounded diagnostics to a failure message without a dangling space.
const withDiagnostics = (message: string, diagnostics: string): string =>
    diagnostics.length > 0 ? `${message} ${diagnostics}` : message;

// A missing interpreter is a setup problem, not a syntax verdict. Throwing keeps
// "false" meaning "your code is wrong"; the harness turns this into a readable
// tool result the model can recover from.
export const checkPython = async (code: string, signal?: AbortSignal): Promise<boolean> => {
    if (typeof code !== 'string') {
        throw new HarnessError('syntaxCheck code must be a string.');
    }

    // Cancelled before anything ran: do not even probe the interpreter.
    if (signal?.aborted) {
        throw new HarnessError('syntaxCheck Python check was cancelled before it started.');
    }

    const interpreter = await findPython();

    if (!interpreter) {
        throw new HarnessError(
            'syntaxCheck requires a Python 3 interpreter on PATH (tried: python3, python).'
        );
    }

    // Cancelled while the probe was running: do not start work that is already
    // unwanted.
    if (signal?.aborted) {
        throw new HarnessError('syntaxCheck Python check was cancelled before it started.');
    }

    return new Promise<boolean>((resolve, reject) => {
        let child: ChildProcess;

        try {
            child = spawn(interpreter, ['-X', 'utf8', '-c', PYTHON_CHECK_SCRIPT], {
                // stdin carries the source; stdout is never read (the script
                // prints nothing); stderr carries diagnostic tracebacks.
                stdio: ['pipe', 'ignore', 'pipe'],
                windowsHide: true,
                // UTF-8 mode for the interpreter's stdio, independent of the
                // Windows locale codec (the cp1252 stdin decode bug).
                env: {
                    ...process.env,
                    PYTHONUTF8: '1',
                    PYTHONIOENCODING: 'utf-8'
                }
            });
        } catch (error) {
            reject(
                new HarnessError('syntaxCheck could not start the Python interpreter.', { cause: error })
            );
            return;
        }

        const stderr = new BoundedText(PYTHON_STDERR_MAX_BYTES);

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Set when a timeout/abort terminates the interpreter: the close handler
        // then reports that harness failure, not the incidental kill signal.
        let termination: HarnessError | undefined;
        // The in-flight tree kill. Results are not settled until it resolves, so a
        // caller cannot observe completion while the process tree is still dying.
        let treeKill: Promise<void> | undefined;

        // Settle exactly once; releases the timer and the abort listener.
        const settle = (finish: () => void): void => {
            if (settled) return;

            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            finish();
        };

        // Terminate the interpreter once, then reject with `error`. Both the kill
        // chain and the close handler funnel into settle(), which keeps the first
        // one and ignores the rest.
        const terminate = (error: HarnessError): void => {
            if (treeKill) return;

            termination = error;
            treeKill = terminateTree(child).then(
                () => settle(() => reject(error)),
                () => settle(() => reject(error))
            );
        };

        const onAbort = (): void => {
            terminate(new HarnessError('syntaxCheck Python check was cancelled.'));
        };

        timer = setTimeout(() => {
            terminate(
                new HarnessError(
                    `syntaxCheck timed out after ${PYTHON_CHECK_TIMEOUT_MS} ms checking Python syntax.`
                )
            );
        }, PYTHON_CHECK_TIMEOUT_MS);

        signal?.addEventListener('abort', onAbort, { once: true });

        child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));

        // The interpreter can exit before consuming stdin (e.g. missing module);
        // that yields EPIPE here, and the exit status below is the real verdict.
        child.stdin?.on('error', () => {});

        child.on('error', (error) =>
            settle(() =>
                reject(
                    new HarnessError('syntaxCheck could not start the Python interpreter.', {
                        cause: error
                    })
                )
            )
        );

        child.on('close', (exitCode, exitSignal) => {
            // A run we terminated is reported only after its tree kill finished.
            if (termination) {
                const failure = termination;
                void treeKill!.then(
                    () => settle(() => reject(failure)),
                    () => settle(() => reject(failure))
                );
                return;
            }

            settle(() => {
                const diagnostics = stderr.end().trim();

                // Killed by a signal: the check never produced a verdict.
                if (exitSignal) {
                    reject(
                        new HarnessError(
                            withDiagnostics(
                                `syntaxCheck Python interpreter ended on signal ${exitSignal}.`,
                                diagnostics
                            )
                        )
                    );
                    return;
                }

                // compile() => SyntaxError exits 1. That is the ONLY non-zero code
                // that means "invalid syntax"; 2 is the script's infrastructure
                // code (decode failure, ValueError, unexpected exception).
                if (exitCode === 1) {
                    resolve(false);
                    return;
                }

                if (exitCode !== 0) {
                    reject(
                        new HarnessError(
                            withDiagnostics(
                                `syntaxCheck Python interpreter exited with code ${String(exitCode)}.`,
                                diagnostics
                            )
                        )
                    );
                    return;
                }

                resolve(true);
            });
        });

        // Hand over the source and close stdin; compile() reads it to EOF.
        child.stdin?.end(code, 'utf8');
    });
};
