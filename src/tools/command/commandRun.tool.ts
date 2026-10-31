// commandRun — execute a shell command and collect its output.
//
// The escape hatch every CLI harness ships, and the most powerful tool here: it
// runs with the permissions of the host process and has NO sandbox, no allowlist,
// and no confirmation step. Treat it the way you would treat a terminal handed to
// the model — run the harness inside a container, a worktree, or an account you
// are willing to have modified.
//
// Executable on its own and registerable on a harness:
//
//     const { exitCode, stdout } = await commandRun({ command: 'git status' });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.
//
// Execution contract (R1):
//   - output is captured through BoundedText, so a chunk boundary never corrupts
//     UTF-8 and memory is bounded: 128 KiB stdout, 16 KiB stderr (head kept);
//   - a run always ends: default timeout 120 s, DEFAULT -> requested value is
//     clamped to a 10-minute hard ceiling. There is no "unlimited" override;
//   - an AbortSignal on the ToolContext (context.signal) cancels the run;
//   - timeouts and aborts terminate the child PROCESS TREE (see ./processTree) —
//     on Windows that is best-effort taskkill, documented there;
//   - a non-zero exit is still returned as data, never thrown, so the model can
//     read the failure and correct itself. Spawn failures (missing cwd/shell) are
//     thrown: those are harness setup problems, not command results.
//
// Result flags:
//   - truncated  true when stdout OR stderr was cut at its cap;
//   - timedOut   true when the timeout timer terminated the run;
//   - aborted    true when context.signal terminated the run;
//   - exitCode   the real exit code for a completed process, or -1 when the run
//                was terminated by a signal or by this tool (timeout/abort). A
//                killed shell's incidental code is not meaningful to the model,
//                so -1 is reported deterministically instead.

import { spawn } from 'node:child_process';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { BoundedText, COMMAND_STDERR_MAX_BYTES, COMMAND_STDOUT_MAX_BYTES } from './boundedText';
import { processGroupOptions, terminateTree } from './processTree';

export type CommandRunParameters = {
    // Shell command line. Pipes, redirects, and quoting work (shell: true).
    command: string;
    // Working directory for the child. Defaults to the harness process cwd.
    cwd?: string;
    // Optional per-run timeout in milliseconds. Omitted = COMMAND_DEFAULT_TIMEOUT_MS;
    // values above COMMAND_MAX_TIMEOUT_MS are clamped to that ceiling. There is no
    // unlimited value: a non-positive/non-finite timeout is rejected.
    timeoutMs?: number;
};

export type CommandRunResult = {
    // Process exit code, or -1 when a signal/this tool terminated the process.
    exitCode: number;
    stdout: string;
    stderr: string;
    // True when stdout or stderr exceeded its byte cap and the tail was dropped.
    truncated: boolean;
    // True when the timeout terminated the run.
    timedOut: boolean;
    // True when context.signal terminated the run.
    aborted: boolean;
};

// 120 seconds is long enough for a real build step and short enough that a hung
// command cannot occupy a run indefinitely.
export const COMMAND_DEFAULT_TIMEOUT_MS = 120_000;

// Hard upper bound. A caller may ask for more, but never get an unbounded run.
export const COMMAND_MAX_TIMEOUT_MS = 600_000;

// After a timeout/abort kills the tree, 'close' normally arrives at once. If it
// does not, the run still resolves this much later with the output captured so
// far, so cancellation can never hang a harness turn.
const KILL_GRACE_MS = 2_000;

// Resolve the per-call timeout. Rejecting bad values (rather than silently
// defaulting) keeps a typo from turning into a 120-second surprise.
const resolveTimeout = (timeoutMs: unknown): number => {
    if (timeoutMs === undefined) return COMMAND_DEFAULT_TIMEOUT_MS;

    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new HarnessError('commandRun timeoutMs must be a positive finite number of milliseconds.');
    }

    return Math.min(Math.floor(timeoutMs), COMMAND_MAX_TIMEOUT_MS);
};

// Validate the shell line and cwd before spawning. `command` is intentionally not
// trimmed on the way to the shell (leading spaces are harmless), but a blank
// string would spawn an interactive/no-op shell, which is never what the model
// meant.
const validate = (parameters: CommandRunParameters): { command: string; cwd?: string; timeoutMs: number } => {
    if (!parameters || typeof parameters !== 'object') {
        throw new HarnessError('commandRun requires a { command } object.');
    }

    const { command, cwd, timeoutMs } = parameters;

    if (typeof command !== 'string' || command.trim().length === 0) {
        throw new HarnessError('commandRun requires a non-empty command string.');
    }

    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0)) {
        throw new HarnessError('commandRun cwd must be a non-empty string when provided.');
    }

    return { command, cwd, timeoutMs: resolveTimeout(timeoutMs) };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const COMMAND_RUN_METADATA: PresetToolMetadata = {
    name: 'commandRun',
    description:
        'Run a shell command and return its exit code, stdout, and stderr. The command string is passed to the platform shell, so pipes, redirects, and quoting work. A non-zero exit code is returned as data, not thrown. `timeoutMs` bounds the run (integer milliseconds, 1-600000, default 120000); a command that exceeds it is killed together with its process tree on a best-effort basis and the result reports `timedOut: true`. Output is capped at 128 KiB of stdout and 16 KiB of stderr, with `truncated: true` when either cap was applied, and an aborted run reports `aborted: true`.',
    tags: ['shell', 'command', 'process'],
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command to run, e.g. "git status --short".' },
            cwd: {
                type: 'string',
                description: 'Working directory. Defaults to the directory the harness was started in.'
            },
            timeoutMs: {
                type: 'integer',
                minimum: 1,
                maximum: 600000,
                default: 120000,
                description:
                    'Wall-clock limit in milliseconds, 1-600000. Defaults to 120000 (2 minutes); the process tree is killed when it is exceeded.'
            }
        },
        required: ['command'],
        additionalProperties: false
    }
};

export const commandRun = tool<CommandRunParameters, CommandRunResult>({
    ...COMMAND_RUN_METADATA,
    execute: (context) => {
        const { command, cwd, timeoutMs } = validate(context.parameters);

        // context.signal is being added to ToolContext by a parallel change; read
        // it structurally so this module works with or without that field typed.
        const signal = (context as { signal?: AbortSignal }).signal;

        // Already cancelled before anything started: report a clean aborted
        // result instead of spawning a process that would be killed at once.
        if (signal?.aborted) {
            return Promise.resolve({
                exitCode: -1,
                stdout: '',
                stderr: '',
                truncated: false,
                timedOut: false,
                aborted: true
            });
        }

        return new Promise<CommandRunResult>((resolve, reject) => {
            // shell: true is deliberate — it is what makes a single string
            // behave like a command line instead of an argv array. The process
            // group options make the whole tree reachable by terminateTree.
            const child = spawn(command, {
                cwd,
                shell: true,
                ...processGroupOptions()
            });

            const stdout = new BoundedText(COMMAND_STDOUT_MAX_BYTES);
            const stderr = new BoundedText(COMMAND_STDERR_MAX_BYTES);

            let timedOut = false;
            let aborted = false;
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let graceTimer: ReturnType<typeof setTimeout> | undefined;
            // Shared kill promise: a timeout and an abort may both fire, but the
            // tree is terminated (and awaited) once.
            let treeKill: Promise<void> | undefined;

            // Settle exactly once: a killed child can emit both 'error' and
            // 'close', and a duplicate resolve/reject would be ignored but would
            // also leak the abort listener and timers.
            const settle = (finish: () => void): void => {
                if (settled) return;

                settled = true;
                if (timer) clearTimeout(timer);
                if (graceTimer) clearTimeout(graceTimer);
                signal?.removeEventListener('abort', onAbort);
                finish();
            };

            // Resolve with whatever was captured even if the killed tree somehow
            // never emits 'close'. Output is already bounded, so this cannot
            // stride past the caps.
            const finishKilled = (): void =>
                settle(() =>
                    resolve({
                        exitCode: -1,
                        stdout: stdout.end(),
                        stderr: stderr.end(),
                        truncated: stdout.truncated || stderr.truncated,
                        timedOut,
                        aborted
                    })
                );

            // A tree kill normally produces 'close' immediately. This grace timer
            // is the backstop that keeps a stuck/cancelled run from hanging. It is
            // only scheduled AFTER terminateTree resolves, so it can never race
            // ahead of the Windows taskkill wait.
            const scheduleGrace = (): void => {
                if (graceTimer === undefined) graceTimer = setTimeout(finishKilled, KILL_GRACE_MS);
            };

            // Start the tree kill once and return the shared promise. The promise
            // resolves only after terminateTree has finished (taskkill awaited on
            // Windows); the 'close' handler waits for it before resolving.
            const terminate = (): Promise<void> => {
                if (!treeKill) {
                    treeKill = terminateTree(child).then(scheduleGrace, scheduleGrace);
                }

                return treeKill;
            };

            const onAbort = (): void => {
                aborted = true;

                // Kill the tree; the 'close' handler resolves with exitCode -1
                // after the kill completes, or the grace timer does.
                void terminate();
            };

            timer = setTimeout(() => {
                timedOut = true;
                void terminate();
            }, timeoutMs);

            // once: the listener is also removed by settle(), which covers the
            // non-abort paths.
            signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
            child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));

            // Spawn failures (missing cwd, no shell) are real errors: the command
            // never ran, so there is no exit code to report as data.
            child.on('error', (error) => settle(() => reject(error)));

            // A non-zero exit is a normal result: the model needs to see it to
            // decide what to do next, so it is returned rather than thrown.
            child.on('close', (code, exitSignal) => {
                const finish = (): void =>
                    settle(() =>
                        resolve({
                            exitCode: timedOut || aborted ? -1 : code ?? (exitSignal ? -1 : 0),
                            stdout: stdout.end(),
                            stderr: stderr.end(),
                            truncated: stdout.truncated || stderr.truncated,
                            timedOut,
                            aborted
                        })
                    );

                // A timed-out/aborted close is reported only after the tree kill
                // has completed, so a caller cannot observe the result while the
                // grandchild is still alive.
                if (treeKill) {
                    void treeKill.then(finish, finish);
                    return;
                }

                finish();
            });
        });
    }
});
