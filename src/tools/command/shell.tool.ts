// shell — execute a shell command and collect its output.
//
// The escape hatch every CLI harness ships, and the most powerful tool here: it
// runs with the permissions of the host process and has NO sandbox, no allowlist,
// and no confirmation step. Treat it the way you would treat a terminal handed to
// the model — run the harness inside a container, a worktree, or an account you
// are willing to have modified.
//
// Executable on its own and registerable on a harness:
//
//     const { exitCode, stdout } = await shell({ command: 'git status' });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.
//
// Execution contract (R1):
//   - a run always ends: default timeout 120 s, DEFAULT -> requested value is
//     clamped to a 10-minute hard ceiling. There is no "unlimited" override;
//   - an AbortSignal on the ToolContext (context.signal) cancels the run;
//   - timeouts and aborts terminate the child PROCESS TREE (see ./processTree) —
//     on Windows that is best-effort taskkill, documented there;
//   - a non-zero exit is still returned as data, never thrown, so the model can
//     read the failure and correct itself. Spawn failures (missing cwd/shell) are
//     thrown: those are harness setup problems, not command results.
//
// The four things a command tool gets wrong most often, and what this file does
// about each (all four were observed against the real tool before being fixed):
//
//   1. WHERE THE ANSWER IS. Builds, test runners and installers print their verdict
//      LAST (`npm test` ends with the failure summary, `tsc` with the error count,
//      `dotnet build` with `Build FAILED`). A head-kept cap therefore throws away
//      exactly the part the model needed. Output is captured head+TAIL with an
//      in-band omission marker (./boundedOutput), and the complete stream is teed
//      to a file so `grep`/`read` can recover the middle.
//   2. WHICH STREAM WAS CUT. One boolean for both streams cannot say whether the
//      text in hand is complete, so each stream reports its own flag, its true byte
//      size, and how many bytes the marker replaced.
//   3. SILENTLY RUNNING ONE LINE. `cmd.exe /c` takes the whole string as one
//      command line and DISCARDS everything after the first newline — `echo a` +
//      `exit 9` exits 0, losing a deliberate failure, while the same string works on
//      bash. On Windows the lines are chained with `&&` before spawning, so every
//      line runs and the reported exit code is the one the model asked for.
//   4. CLAIMING A TIMEOUT THAT DID NOT HAPPEN. A timer firing in the same
//      event-loop batch as a normal exit used to overwrite a real exit code with
//      `exitCode: -1, timedOut: true`. A run that finished on its own is now always
//      reported as finished; the kill only speaks when it was actually needed.
//
// Result flags:
//   - truncated         true when EITHER stream was cut at its cap;
//   - stdoutTruncated / true for that stream alone. `stderrTruncated` matches the
//     stderrTruncated  name gitDiff already publishes;
//   - stdoutBytes /     the TRUE size of each stream, cut or not, and how many of
//     stderrBytes /     those bytes the in-band marker replaced;
//   - stdoutDropped…    0 unless that stream was truncated;
//   - outputPath        file holding the complete output, when a stream was cut
//                       (null when nothing was cut, saving is off, or the write
//                       failed);
//   - timedOut          true only when the timeout really terminated the run;
//   - aborted           true only when context.signal really terminated the run;
//   - exitCode          the process exit code, normalised to the SIGNED int32
//                       convention (so `process.exit(-1)` reads -1 on Windows
//                       instead of 4294967295), or -1 when a signal or this tool
//                       terminated the run. A killed shell's incidental code is not
//                       meaningful to the model, so -1 is reported deterministically;
//   - exitSignal        the signal name a kill produced, or null;
//   - durationMs        wall-clock milliseconds the run occupied;
//   - linesChained      how many line breaks the Windows normalisation folded into
//                       one command line (0 when the string went to the shell
//                       untouched, so non-zero means the shell ran a rewritten line).

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { COMMAND_STDERR_MAX_BYTES, COMMAND_STDOUT_MAX_BYTES } from './boundedText';
import { BoundedOutput } from './boundedOutput';
import { processGroupOptions, terminateTree } from './processTree';

export type CommandRunParameters = {
    // Shell command line. Pipes, redirects, and quoting work (shell: true).
    // On Windows, newline-separated lines are chained with `&&` first (see above).
    command: string;
    // Working directory for the child. Defaults to the harness process cwd.
    cwd?: string;
    // Optional per-run timeout in milliseconds. Omitted = COMMAND_DEFAULT_TIMEOUT_MS;
    // values above COMMAND_MAX_TIMEOUT_MS are clamped to that ceiling. There is no
    // unlimited value: a non-positive/non-finite timeout is rejected.
    timeoutMs?: number;
    // Bytes fed to the child's stdin, then EOF. Omitted = stdin is IGNORED, so a
    // command that reads it sees end-of-input at once instead of blocking until the
    // timeout waiting for a terminal that will never type anything.
    input?: string;
    // Write the complete (uncapped) output to a file when a stream is cut, and
    // report its path. Defaults to true; false keeps the result in memory only.
    saveOutput?: boolean;
};

export type CommandRunResult = {
    // Process exit code (signed int32), or -1 when a signal/this tool terminated it.
    exitCode: number;
    stdout: string;
    stderr: string;
    // True when EITHER stream exceeded its byte cap.
    truncated: boolean;
    // Per-stream truncation: which side of the result is incomplete.
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    // True size of each stream in bytes, whether or not it was capped.
    stdoutBytes: number;
    stderrBytes: number;
    // Bytes the in-band `[... N bytes omitted ...]` marker replaced; 0 unless that
    // stream was truncated.
    stdoutDroppedBytes: number;
    stderrDroppedBytes: number;
    // Absolute path of the file holding the full output, or null. Written only when
    // a stream was cut and `saveOutput` is on.
    outputPath: string | null;
    // True when the timeout terminated the run.
    timedOut: boolean;
    // True when context.signal terminated the run.
    aborted: boolean;
    // Signal name when the process was killed, else null.
    exitSignal: string | null;
    // Wall-clock milliseconds from spawn to settle.
    durationMs: number;
    // Line breaks the Windows normalisation folded into one command line; 0 when
    // the string went to the shell untouched. Non-zero means the command the shell
    // ran is not byte-for-byte what was sent.
    linesChained: number;
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

// Where the full-output tee lands, relative to the harness working directory, and
// how much of each stream it holds. A dot-folder so a plain `glob **/*` over a
// repository is not polluted by it, matching ../webdownload/download.tool.ts.
// The cap keeps a pathological stream (a build that prints 500 MB) bounded in
// memory and on disk; it is 64x the model-facing cap, so the file recovers the
// middle of anything the result had to cut, and its in-band marker says where it
// stopped.
const OUTPUT_FOLDER = '.underload/shell';
const OUTPUT_FILE_MAX_BYTES = 8 * 1024 * 1024;

// One counter per process is enough to make a file name unique next to the pid and
// the millisecond stamp, including for concurrent runs of this tool.
let outputSequence = 0;

// Resolve the per-call timeout. Rejecting bad values (rather than silently
// defaulting) keeps a typo from turning into a 120-second surprise.
const resolveTimeout = (timeoutMs: unknown): number => {
    if (timeoutMs === undefined) return COMMAND_DEFAULT_TIMEOUT_MS;

    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new HarnessError('shell timeoutMs must be a positive finite number of milliseconds.');
    }

    return Math.min(Math.floor(timeoutMs), COMMAND_MAX_TIMEOUT_MS);
};

// Validate the shell line and cwd before spawning. `command` is intentionally not
// trimmed on the way to the shell (leading spaces are harmless), but a blank
// string would spawn an interactive/no-op shell, which is never what the model
// meant.
const validate = (parameters: CommandRunParameters): {
    command: string;
    cwd?: string;
    timeoutMs: number;
    input?: string;
    saveOutput: boolean;
} => {
    if (!parameters || typeof parameters !== 'object') {
        throw new HarnessError('shell requires a { command } object.');
    }

    const { command, cwd, timeoutMs, input, saveOutput } = parameters;

    if (typeof command !== 'string' || command.trim().length === 0) {
        throw new HarnessError('shell requires a non-empty command string.');
    }

    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length === 0)) {
        throw new HarnessError('shell cwd must be a non-empty string when provided.');
    }

    // The harness does not validate JSON Schema, so a model can send a number or
    // "true". Reject rather than coerce: silently stringifying a wrong type would
    // feed the child bytes nobody asked for.
    if (input !== undefined && typeof input !== 'string') {
        throw new HarnessError('shell input must be a string when provided.');
    }

    if (saveOutput !== undefined && typeof saveOutput !== 'boolean') {
        throw new HarnessError('shell saveOutput must be a boolean when provided.');
    }

    return { command, cwd, timeoutMs: resolveTimeout(timeoutMs), input, saveOutput: saveOutput !== false };
};

// cmd.exe receives the whole string as ONE command line, so a newline is not a
// statement separator there: everything after the first one is discarded. That is
// silently lossy for the multi-line blocks models emit constantly — `echo a` +
// `exit 9` exits 0 because `exit 9` never ran — while the identical string works on
// bash. Chain the lines instead, with the two rules that keep it honest:
//
//   - a newline inside a double-quoted argument is LEFT ALONE: it is part of an
//     argument, not a statement break, and `&&` would corrupt the string;
//   - a line that already ends in a shell separator (`&`, `|`, `^`) is joined with a
//     plain space, because `a& && b` is a cmd.exe syntax error.
//
// `&&` rather than `&`: a failing first line should stop the rest, which is what a
// caller means by typing several commands in one block. Blank lines and the
// whitespace around each break collapse away, and a trailing newline is dropped
// (a pasted block ending in \n must not become `a && `).
//
// POSIX shells are returned untouched: they already run every line, and rewriting
// them would break real block syntax (`if …; then` + a following line is not a
// `&&` chain). The result is that every line runs on BOTH platforms, which is the
// consistency the model needs.
const chainWindowsLines = (command: string): { command: string; linesChained: number } => {
    if (process.platform !== 'win32' || !/[\r\n]/.test(command)) {
        return { command, linesChained: 0 };
    }

    let out = '';
    let chained = 0;
    // cmd.exe's only quoting level is the double quote; a single quote is an
    // ordinary character there, so it must not be tracked.
    let inQuotes = false;

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index] as string;

        // `^` escapes the next character outside quotes; copy the pair verbatim so
        // an escaped quote never flips the quote state.
        if (!inQuotes && char === '^' && index + 1 < command.length) {
            out += char + command[index + 1];
            index += 1;
            continue;
        }

        if (char === '"') {
            inQuotes = !inQuotes;
            out += char;
            continue;
        }

        if (inQuotes || (char !== '\n' && char !== '\r')) {
            out += char;
            continue;
        }

        // Consume the whole break: the newline run plus the whitespace around it.
        let cursor = index;

        while (cursor < command.length && /[\r\n \t]/.test(command[cursor] as string)) cursor += 1;

        // Every break consumed is reported, because a folded break — dropped or
        // joined — means the string the shell received is not the string sent.
        chained += 1;
        index = cursor;

        // Nothing after it: a trailing break, dropped rather than left dangling.
        if (cursor >= command.length) continue;

        // A leading break with nothing before it: nothing to chain on to.
        if (out.trim().length === 0) continue;

        out += /[&|^]$/.test(out.trimEnd()) ? ' ' : ' && ';
    }

    return { command: out, linesChained: chained };
};

// Node reports the Win32 exit code unsigned, so `process.exit(-1)` arrives as
// 4294967295 — correct, and useless to a model that then has to notice a ten-digit
// number means "failed". Reading the same bits as a signed int32 gives -1, which is
// the convention both POSIX shells and cmd.exe itself use.
const signedExitCode = (code: number | null): number => {
    if (code === null) return -1;

    return code > 0x7f_ff_ff_ff ? code - 0x1_0000_0000 : code;
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const COMMAND_RUN_METADATA: PresetToolMetadata = {
    name: 'shell',
    description:
        'Run a shell command and return its exit code, stdout, and stderr. The command string is passed to the platform shell, so pipes, redirects, and quoting work. A non-zero exit code is returned as data, not thrown. On Windows (cmd.exe) a multi-line command is chained with `&&` before it runs, because cmd.exe would otherwise execute ONLY its first line and discard the rest; a failing line stops the ones after it. `timeoutMs` bounds the run (integer milliseconds, 1-600000, default 120000); a command still running when it fires is killed together with its process tree on a best-effort basis - `taskkill /T` cannot reach detached, `start`-spawned, or reparented descendants, so those may survive holding ports and CPU - and the result reports `timedOut: true` with `exitCode: -1`; a run that finished on its own is never reported as timed out. Cancelling the run reports `aborted: true`. stdin is closed by default so a command that reads it gets EOF at once instead of hanging, and `input` feeds it instead. Output is capped at 128 KiB of stdout and 16 KiB of stderr, keeping the BEGINNING and the END with an in-band `[... N bytes omitted ...]` marker, because build and test output is read from the end: `stdoutTruncated`/`stderrTruncated` say which stream was cut, `stdoutBytes`/`stderrBytes` give each stream true size, `stdoutDroppedBytes`/`stderrDroppedBytes` what the marker replaced, and `outputPath` names a file holding the complete output whenever either stream was cut (`saveOutput: false` skips it). `durationMs` reports how long the run took and `exitSignal` the signal a kill produced.',
    tags: ['shell', 'command', 'process'],
    parameters: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description:
                    'Shell command to run, e.g. "git status --short". On Windows, newline-separated lines are chained with `&&`; on POSIX they run as written.'
            },
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
                    'Wall-clock limit in milliseconds, 1-600000. Defaults to 120000 (2 minutes); the process tree is killed when it is exceeded and the run already finished is not reported as timed out.'
            },
            input: {
                type: 'string',
                description:
                    'Bytes fed to stdin, then EOF. Omit it and stdin is closed, so a command that reads stdin does not block until the timeout.'
            },
            saveOutput: {
                type: 'boolean',
                description:
                    'When a stream is cut, also write the complete output to a file and report it as `outputPath`. Defaults to true; false keeps the result in memory only.'
            }
        },
        required: ['command'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = COMMAND_RUN_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // T2/R2: ASYNC. A command can run for minutes, and its outcome is independent of
    // whatever else this message started, so its completion triggers its own turn (the
    // historical background-tool behaviour) instead of holding the batch.
    mode: 'async',
    order: 220,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

// The full-output tee. Best-effort by construction: a result that already carries
// the head, the tail, and the exact byte counts is not worth failing because a
// scratch file could not be created, so every error collapses to `null`.
const writeFullOutput = async (
    command: string,
    exitCode: number,
    durationMs: number,
    stdout: BoundedOutput,
    stderr: BoundedOutput
): Promise<string | null> => {
    const directory = resolve(process.cwd(), OUTPUT_FOLDER);
    const name = `${Date.now().toString(36)}-${process.pid.toString(36)}-${(outputSequence += 1).toString(36)}.txt`;
    const path = join(directory, name);

    // One header line naming the command, then each stream verbatim, so `grep` over
    // the file sees the command output itself rather than a wrapper per line.
    const body = [
        `# shell: ${command.replaceAll(/[\r\n]+/g, ' ')}`,
        `# exitCode=${exitCode} durationMs=${durationMs} stdout=${stdout.totalBytes}B stderr=${stderr.totalBytes}B`,
        stdout.end(),
        `# --- stderr (${stderr.totalBytes} bytes) ---`,
        stderr.end()
    ].join('\n');

    try {
        await mkdir(directory, { recursive: true });
        await writeFile(path, body, 'utf8');

        return path;
    } catch {
        return null;
    }
};

export const shell = tool<CommandRunParameters, CommandRunResult>({
    ...COMMAND_RUN_METADATA,
    // T2/R2: mirrors `registration.mode` ('async'), so a host that registers this
    // preset directly keeps the long-running command's independent-turn behaviour.
    mode: 'async',
    execute: (context) => {
        const { cwd, timeoutMs, input, saveOutput } = validate(context.parameters);

        // The line as the model wrote it, and the line the shell will actually get.
        // They differ only on Windows with a multi-line command (see chainWindowsLines),
        // and the saved-output header names the first because that is what the caller
        // recognises.
        const requestedCommand = context.parameters.command;
        const { command, linesChained } = chainWindowsLines(requestedCommand);

        // context.signal is being added to ToolContext by a parallel change; read
        // it structurally so this module works with or without that field typed.
        const signal = (context as { signal?: AbortSignal }).signal;

        const startedAt = performance.now();

        // The shape every path resolves with, so the early-abort return, the normal
        // close, and the kill backstop cannot drift apart.
        const emptyResult = (over: Partial<CommandRunResult>): CommandRunResult => ({
            exitCode: -1,
            stdout: '',
            stderr: '',
            truncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutDroppedBytes: 0,
            stderrDroppedBytes: 0,
            outputPath: null,
            timedOut: false,
            aborted: false,
            exitSignal: null,
            durationMs: 0,
            linesChained,
            ...over
        });

        // Already cancelled before anything started: report a clean aborted
        // result instead of spawning a process that would be killed at once.
        if (signal?.aborted) {
            return Promise.resolve(emptyResult({ aborted: true }));
        }

        return new Promise<CommandRunResult>((resolvePromise, rejectPromise) => {
            // shell: true is deliberate — it is what makes a single string
            // behave like a command line instead of an argv array. The process
            // group options make the whole tree reachable by terminateTree.
            //
            // stdin is IGNORED unless the caller asked for `input`. An ignored
            // stdin is an immediate EOF, which is what a non-interactive command
            // needs; a PIPE with nobody writing (the previous default) is an
            // endless empty stream, so anything that read stdin blocked until the
            // timeout and `timeout.exe` refused to run at all.
            const child = spawn(command, {
                cwd,
                shell: true,
                stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                ...processGroupOptions()
            });

            // Head+tail capture for the result, plus a 64x-larger mirror for the
            // full-output file. Both are byte-bounded, so a 500 MB build log costs
            // a bounded amount of memory either way.
            const stdout = new BoundedOutput(COMMAND_STDOUT_MAX_BYTES);
            const stderr = new BoundedOutput(COMMAND_STDERR_MAX_BYTES);
            const rawStdout = new BoundedOutput(OUTPUT_FILE_MAX_BYTES);
            const rawStderr = new BoundedOutput(OUTPUT_FILE_MAX_BYTES);

            let timedOut = false;
            let aborted = false;
            // True once THIS tool decided to kill the tree. It is the only thing the
            // exit-code branch consults, so a timer that fires in the same batch as a
            // normal exit can no longer overwrite a completed run.
            let terminated = false;
            // Set on the child's 'exit' so the settle paths know the process finished
            // by itself even if 'close' (which waits for the pipes to drain) has not
            // arrived yet.
            let exited = false;
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let graceTimer: ReturnType<typeof setTimeout> | undefined;
            // Shared kill promise: a timeout and an abort may both fire, but the
            // tree is terminated (and awaited) once.
            let treeKill: Promise<void> | undefined;

            // The child is still running when neither its exit nor a signal has been
            // reported. Node fills in `exitCode`/`signalCode` as soon as 'exit'
            // arrives, which is exactly the window the race below closes.
            const isRunning = (): boolean =>
                !exited && child.exitCode === null && child.signalCode === null;

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

            // Build the result and resolve it. The full-output write is awaited so a
            // caller that greps `outputPath` never races a half-written file; the
            // grace backstop below still bounds the whole thing.
            const deliver = (exitCode: number, exitSignal: string | null): void => {
                const result = emptyResult({
                    exitCode,
                    stdout: stdout.end(),
                    stderr: stderr.end(),
                    truncated: stdout.truncated || stderr.truncated,
                    stdoutTruncated: stdout.truncated,
                    stderrTruncated: stderr.truncated,
                    stdoutBytes: stdout.totalBytes,
                    stderrBytes: stderr.totalBytes,
                    stdoutDroppedBytes: stdout.truncated ? stdout.droppedBytes : 0,
                    stderrDroppedBytes: stderr.truncated ? stderr.droppedBytes : 0,
                    timedOut,
                    aborted,
                    exitSignal,
                    durationMs: Math.max(0, Math.round(performance.now() - startedAt))
                });

                if (!saveOutput || !result.truncated) {
                    resolvePromise(result);
                    return;
                }

                void writeFullOutput(requestedCommand, exitCode, result.durationMs, rawStdout, rawStderr).then(
                    (path) => {
                        result.outputPath = path;
                        resolvePromise(result);
                    },
                    () => resolvePromise(result)
                );
            };

            // Resolve with whatever was captured even if the killed tree somehow
            // never emits 'close'. Output is already bounded, so this cannot
            // stride past the caps. A process that exited on its own but left a
            // descendant holding the pipes still has a real code on `child`, so the
            // kill is not assumed here — only when THIS tool did the killing.
            const finishKilled = (): void =>
                settle(() =>
                    deliver(terminated ? -1 : signedExitCode(child.exitCode), child.signalCode ?? null)
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

            // A cancellation or timeout that arrives after the process already ended
            // terminated nothing: report the real result and skip the kill. Without
            // this guard a timer landing in the same event-loop batch as a normal
            // exit turned a completed run into `exitCode: -1, timedOut: true`.
            //
            // The already-finished branch still arms the grace backstop: 'close'
            // waits for the pipes to drain, and a surviving descendant can hold them
            // open forever, so skipping the kill must not mean skipping the bound.
            const terminateFor = (flag: 'timedOut' | 'aborted'): void => {
                if (settled) return;

                if (!isRunning()) {
                    scheduleGrace();
                    return;
                }

                terminated = true;
                if (flag === 'timedOut') timedOut = true;
                else aborted = true;

                void terminate();
            };

            const onAbort = (): void => terminateFor('aborted');

            timer = setTimeout(() => terminateFor('timedOut'), timeoutMs);

            // once: the listener is also removed by settle(), which covers the
            // non-abort paths.
            signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout?.on('data', (chunk: Buffer) => {
                stdout.write(chunk);
                rawStdout.write(chunk);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
                stderr.write(chunk);
                rawStderr.write(chunk);
            });

            if (input !== undefined && child.stdin) {
                // An error listener is mandatory: a child that exits early makes the
                // pending write fail with EPIPE/EOF, and an unhandled 'error' on that
                // stream would throw out of the process rather than end the run.
                child.stdin.on('error', () => undefined);
                child.stdin.end(input);
            }

            child.on('exit', () => {
                exited = true;
            });

            // Spawn failures (missing cwd, no shell) are real errors: the command
            // never ran, so there is no exit code to report as data.
            child.on('error', (error) => settle(() => rejectPromise(error)));

            // A non-zero exit is a normal result: the model needs to see it to
            // decide what to do next, so it is returned rather than thrown.
            child.on('close', (code, exitSignal) => {
                // settle() first: it clears the timeout timer and the abort listener,
                // which a completed run must not leave armed for the rest of
                // `timeoutMs` (120 s by default) holding the event loop open.
                const finish = (): void =>
                    settle(() =>
                        deliver(
                            // A run THIS tool killed has no meaningful code (cmd.exe
                            // exits 1 under taskkill /F, 0 under some aborts), so -1 is
                            // reported deterministically. Anything else is the process's
                            // own code.
                            terminated ? -1 : signedExitCode(code),
                            exitSignal ?? null
                        )
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
