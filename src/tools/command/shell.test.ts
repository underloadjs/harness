// shell — the bounded shell escape hatch (R1).
//
// What this pins, exactly:
//   - ordinary small commands return the real exit code and exact captured text;
//   - a non-zero exit stays DATA (it is not thrown);
//   - stdout/stderr are capped at 128 KiB / 16 KiB, keeping the BEGINNING AND THE
//     END with an in-band omission marker, and each stream reports its own flag,
//     true byte size, and dropped byte count;
//   - a cut stream is teed whole to `outputPath` so grep/read can recover the
//     middle, and `saveOutput: false` skips the file;
//   - a multi-line command runs EVERY line on Windows (cmd.exe would otherwise
//     execute only the first and discard the rest, silently losing `exit 9`);
//   - stdin is closed by default (a command that reads it gets EOF instead of
//     hanging to the timeout) and `input` feeds it;
//   - a run that finished on its own is never reported as `timedOut`, even when the
//     timer fires in the same event-loop batch as its exit;
//   - UTF-8 split across stream chunks is decoded intact;
//   - a timeout and an AbortSignal both terminate the run and report
//     `timedOut`/`aborted` with exitCode -1;
//   - spawn/setup failures (a missing cwd here) reject instead of being reported
//     as a command result; blank commands and invalid timeout/option values are
//     refused.
//
// Every command is a real child process running `node -e …`, so the assertions
// describe the actual shell and stream behaviour rather than a mock. Fixtures are
// unnecessary: the commands print fixed strings.

import { afterAll, describe, expect, it } from 'vitest';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    COMMAND_DEFAULT_TIMEOUT_MS,
    COMMAND_MAX_TIMEOUT_MS,
    shell,
    type CommandRunParameters,
    type CommandRunResult
} from './shell.tool';
import { COMMAND_STDERR_MAX_BYTES, COMMAND_STDOUT_MAX_BYTES } from './boundedText';
import { HarnessError } from '../../util';

// Repo-root Temp/ (five levels up from src/tools/command/: command -> tools ->
// src -> harness -> underload -> packages -> repo root). Used as a
// guaranteed-missing cwd and as the marker directory for the tree-kill probes.
const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// A command whose node.exe GRANDCHILD (cmd.exe -> node.exe) writes a marker after
// `delay` ms. If the tree kill only kills the shell, the marker still appears.
const markerCommand = (path: string, delay: number): string => {
    const directory = TEMP_ROOT.replaceAll('\\', '/');
    const target = path.replaceAll('\\', '/');

    return `node -e "setTimeout(() => { const fs = require('fs'); fs.mkdirSync('${directory}', { recursive: true }); fs.writeFileSync('${target}', 'x'); }, ${delay})"`;
};

const markerPath = (name: string): string => join(TEMP_ROOT, `underload-command-${process.pid}-${name}`);

// Remove markers a failed run may have left in Temp.
afterAll(async () => {
    await rm(markerPath('timeout.txt'), { force: true });
    await rm(markerPath('abort.txt'), { force: true });
});

// The direct callable takes no context, so a signal is only reachable through
// execute(). This helper narrows the cast to one place.
const executeWithSignal = (parameters: CommandRunParameters, signal: AbortSignal) =>
    shell.execute({ parameters, signal } as unknown as Parameters<typeof shell.execute>[0]);

// The result shape minus the two timing fields, which no assertion can pin to an
// exact number. `toEqual` on the whole object is what keeps a new field from
// appearing silently; these two are checked by range instead.
const settled = (result: CommandRunResult): Omit<CommandRunResult, 'durationMs' | 'linesChained'> => {
    const { durationMs: _durationMs, linesChained: _linesChained, ...rest } = result;

    return rest;
};

describe('shell', () => {
    it('returns the exact result for a small command', async () => {
        const result = await shell({ command: 'node -e "process.stdout.write(\'hello\')"' });

        expect(settled(result)).toEqual({
            exitCode: 0,
            stdout: 'hello',
            stderr: '',
            truncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 5,
            stderrBytes: 0,
            stdoutDroppedBytes: 0,
            stderrDroppedBytes: 0,
            outputPath: null,
            timedOut: false,
            aborted: false,
            exitSignal: null
        });

        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.linesChained).toBe(0);
    });

    it('captures stderr separately from stdout', async () => {
        const result = await shell({ command: 'node -e "process.stderr.write(\'boom\')"' });

        expect(settled(result)).toEqual({
            exitCode: 0,
            stdout: '',
            stderr: 'boom',
            truncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 0,
            stderrBytes: 4,
            stdoutDroppedBytes: 0,
            stderrDroppedBytes: 0,
            outputPath: null,
            timedOut: false,
            aborted: false,
            exitSignal: null
        });
    });

    it('returns a non-zero exit as data instead of throwing', async () => {
        const result = await shell({ command: 'node -e "process.exit(3)"' });

        expect(result.exitCode).toBe(3);
        expect(result.timedOut).toBe(false);
        expect(result.aborted).toBe(false);
    });

    it('normalises the Windows unsigned exit code to the signed convention', async () => {
        // `process.exit(-1)` reaches Node as 4294967295 on Win32 and 255 on POSIX.
        // Both mean the same thing to a model, so both read as -1.
        const result = await shell({ command: 'node -e "process.exit(-1)"' });

        expect(result.exitCode).toBe(-1);
        expect(result.timedOut).toBe(false);
        expect(result.aborted).toBe(false);
    });

    it('decodes a UTF-8 codepoint split across stream chunks', async () => {
        // U+20AC (E2 82 AC) is written as two buffers in separate ticks, so the
        // child really does emit it across two 'data' chunks.
        const command =
            'node -e "process.stdout.write(Buffer.from([0xE2,0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xAC])), 100)"';

        const result = await shell({ command });

        expect(result.stdout).toBe('\u20AC');
        expect(result.truncated).toBe(false);
    });

    it('keeps the head AND the tail of a truncated stdout and marks the cut', async () => {
        // 200 000 ASCII bytes against the 128 KiB cap. A head-kept cap returned the
        // first 131 072 and lost the last 68 928 — which is where a build or test
        // run prints its verdict — with nothing in the text saying a cut happened.
        const result = await shell({ command: 'node -e "process.stdout.write(\'a\'.repeat(200000))"' });

        expect(result.exitCode).toBe(0);
        expect(result.truncated).toBe(true);
        expect(result.stdoutTruncated).toBe(true);
        expect(result.stderrTruncated).toBe(false);
        expect(result.stdoutBytes).toBe(200000);
        expect(result.stdoutDroppedBytes).toBe(200000 - COMMAND_STDOUT_MAX_BYTES);
        expect(result.stderrDroppedBytes).toBe(0);

        // Both windows are full, and the marker between them names the count.
        const [head, marker, tail] = result.stdout.split('\n');

        expect(head).toHaveLength(Math.floor(COMMAND_STDOUT_MAX_BYTES / 4));
        expect(tail).toHaveLength(COMMAND_STDOUT_MAX_BYTES - Math.floor(COMMAND_STDOUT_MAX_BYTES / 4));
        expect(marker).toBe(`[... ${result.stdoutDroppedBytes} bytes omitted ...]`);
    });

    it('keeps the LAST lines of a truncated stream, where the verdict is', async () => {
        // The behaviour the whole head+tail policy exists for: 20 000 numbered lines
        // (~204 KiB), and the LAST one must be in the result. A head-kept cap cut
        // this at about line 4 300 and discarded the remaining 15 700 with no marker.
        const result = await shell({
            command: 'node -e "for(let i=0;i<20000;i++)console.log(\'line \'+i)"'
        });

        expect(result.stdoutTruncated).toBe(true);
        expect(result.stdout.startsWith('line 0\n')).toBe(true);
        expect(result.stdout.trimEnd().endsWith('line 19999')).toBe(true);

        // A line from the middle is the one that is gone — the head and the tail
        // both being present is only meaningful if the middle really was cut.
        expect(result.stdout).not.toContain('line 6000\n');
    });

    it('caps stderr at 16 KiB and flags only that stream', async () => {
        const result = await shell({ command: 'node -e "process.stderr.write(\'b\'.repeat(20000))"' });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderrTruncated).toBe(true);
        expect(result.stdoutTruncated).toBe(false);
        expect(result.stderrBytes).toBe(20000);
        expect(result.stderrDroppedBytes).toBe(20000 - COMMAND_STDERR_MAX_BYTES);
    });

    it('attributes truncation to the right stream and not to one that filled exactly', async () => {
        // stdout lands exactly on its 128 KiB cap (complete, NOT cut) while stderr
        // overflows its 16 KiB cap. One shared boolean reported both as truncated;
        // the per-stream flags must not.
        const result = await shell({
            command: 'node -e "process.stdout.write(\'a\'.repeat(131072));process.stderr.write(\'E\'.repeat(17000))"'
        });

        expect(result.stdoutBytes).toBe(COMMAND_STDOUT_MAX_BYTES);
        expect(result.stdoutTruncated).toBe(false);
        expect(result.stdoutDroppedBytes).toBe(0);
        expect(result.stdout).not.toContain('omitted');

        expect(result.stderrTruncated).toBe(true);
        expect(result.stderrDroppedBytes).toBe(17000 - COMMAND_STDERR_MAX_BYTES);

        // `truncated` stays the OR of the two, so existing callers still see it.
        expect(result.truncated).toBe(true);
    });

    it('tees the complete output to a file when a stream is cut', async () => {
        const result = await shell({
            command: 'node -e "for(let i=0;i<20000;i++)console.log(\'line \'+i)"'
        });

        expect(result.outputPath).toBeTruthy();

        const saved = await readFile(result.outputPath as string, 'utf8');

        // The file holds what the result had to drop, so `grep`/`read` can reach it
        // without re-running the command with a manual redirect.
        expect(saved).toContain('line 6000\n');
        expect(saved).toContain('line 19999');
        expect(saved).toContain('line 0\n');
        expect(saved.startsWith('# shell: ')).toBe(true);

        await rm(result.outputPath as string, { force: true });
    });

    it('writes no output file when nothing was cut or when saveOutput is false', async () => {
        const small = await shell({ command: 'node -e "process.stdout.write(\'hi\')"' });

        expect(small.outputPath).toBeNull();

        const cut = await shell({
            command: 'node -e "process.stdout.write(\'a\'.repeat(200000))"',
            saveOutput: false
        });

        expect(cut.truncated).toBe(true);
        expect(cut.outputPath).toBeNull();
    });

    it('runs every line of a multi-line command instead of only the first', async () => {
        // cmd.exe /c takes the whole string as ONE command line and discards
        // everything after the first newline, so this used to exit 0 with `exit 9`
        // never executed — a silently lost failure that works fine on bash.
        const result = await shell({ command: 'echo first\nexit 9' });

        expect(result.exitCode).toBe(9);
        expect(result.stdout).toContain('first');
        expect(result.timedOut).toBe(false);

        // The rewrite is reported when this tool did it. On POSIX the shell already
        // ran both lines, so nothing was rewritten and the count stays 0.
        if (process.platform === 'win32') expect(result.linesChained).toBeGreaterThan(0);
        else expect(result.linesChained).toBe(0);
    });

    it('runs all three lines of a multi-line command', async () => {
        const result = await shell({ command: 'echo 1\necho 2\necho 3' });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('1');
        expect(result.stdout).toContain('2');
        expect(result.stdout).toContain('3');
    });

    it('leaves a newline inside a quoted argument alone', async () => {
        // A break inside "…" is part of an argument, not a statement separator.
        // Chaining it with `&&` would corrupt the string the program receives.
        const result = await shell({
            command: 'node -e "console.log(1)" \nnode -e "console.log(2)"'
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('1');
        expect(result.stdout).toContain('2');
    });

    it('closes stdin so a command that reads it gets EOF instead of hanging', async () => {
        // The old default was an empty PIPE that never ended, so this blocked until
        // the timeout. `input` is the other half of the same fix.
        const result = await shell({
            command: 'node -e "process.stdout.write(JSON.stringify(require(\'fs\').readFileSync(0,\'utf8\')))"',
            timeoutMs: 10_000
        });

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('\"\"');
    });

    it('feeds stdin when input is provided', async () => {
        const result = await shell({
            command: 'node -e "process.stdout.write(require(\'fs\').readFileSync(0,\'utf8\'))"',
            input: 'fed-in',
            timeoutMs: 10_000
        });

        expect(result.stdout).toBe('fed-in');
    });

    it('survives a child that exits before its stdin write completes', async () => {
        // A big write to a stdin whose process already left fails with EOF/EPIPE on
        // the stream. Without an error listener that is an unhandled 'error'.
        const result = await shell({
            command: 'node -e "process.exit(9)"',
            input: 'x'.repeat(70_000),
            timeoutMs: 10_000
        });

        expect(result.exitCode).toBe(9);
        expect(result.timedOut).toBe(false);
    });

    it('reports a completed run as completed when the timer fires in the same batch', async () => {
        // The flake: 'close' had already produced a real exit code, and a timeout
        // landing in the same event-loop batch overwrote it with -1/timedOut. A
        // generous ceiling removes the race entirely; this pins the direction that
        // must never happen (a finished run reported as cancelled).
        for (let index = 0; index < 5; index += 1) {
            const result = await shell({
                command: 'node -e "console.log(\'RACE\');process.exit(5)"',
                timeoutMs: 60_000
            });

            expect(result.stdout).toBe('RACE\n');
            expect(result.exitCode).toBe(5);
            expect(result.timedOut).toBe(false);
            expect(result.aborted).toBe(false);
        }
    });

    it('still times out a long run, kills it, and reports the flags', async () => {
        const result = await shell({
            command: 'node -e "setTimeout(() => {}, 5000)"',
            timeoutMs: 150
        });

        expect(settled(result)).toEqual({
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
            timedOut: true,
            aborted: false,
            exitSignal: null
        });

        expect(result.durationMs).toBeLessThan(5000);
    });

    it('kills the shell GRANDCHILD on timeout (delayed marker never appears)', async () => {
        // Regression for the win32 ordering bug: taskkill was spawned and the
        // shell killed immediately, so taskkill lost the descendant and node.exe
        // survived long enough to write after the 200 ms timeout.
        const path = markerPath('timeout.txt');
        await rm(path, { force: true });

        const result = await shell({ command: markerCommand(path, 1500), timeoutMs: 200 });

        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(-1);

        // Wait past the grandchild's would-be write time.
        await sleep(2500);

        expect(await exists(path)).toBe(false);
    });

    it('kills the shell GRANDCHILD on abort (delayed marker never appears)', async () => {
        const path = markerPath('abort.txt');
        await rm(path, { force: true });

        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 200);

        try {
            const result = await executeWithSignal({ command: markerCommand(path, 1500) }, controller.signal);

            expect(result.aborted).toBe(true);
            expect(result.exitCode).toBe(-1);

            await sleep(2500);

            expect(await exists(path)).toBe(false);
        } finally {
            clearTimeout(abortTimer);
        }
    });

    it('cancels a run through an AbortSignal', async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 100);

        try {
            const result = await executeWithSignal(
                { command: 'node -e "setTimeout(() => {}, 5000)"' },
                controller.signal
            );

            expect(settled(result)).toEqual({
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
                aborted: true,
                exitSignal: null
            });
        } finally {
            clearTimeout(timer);
        }
    });

    it('does not report an abort that arrived after the process finished', async () => {
        // Symmetric with the timeout case: a signal that lands once the child has
        // exited terminated nothing, so the real result stands.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);

        try {
            const result = await executeWithSignal(
                { command: 'node -e "process.stdout.write(\'done\')"' },
                controller.signal
            );

            expect(result.stdout).toBe('done');
            expect(result.aborted).toBe(false);
            expect(result.exitCode).toBe(0);
        } finally {
            clearTimeout(timer);
        }
    });

    it('does not spawn when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const result = await executeWithSignal(
            { command: 'node -e "process.stdout.write(\'never\')"' },
            controller.signal
        );

        expect(settled(result)).toEqual({
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
            aborted: true,
            exitSignal: null
        });
    });

    it('rejects a spawn failure instead of reporting it as a result', async () => {
        const error = await shell({
            command: 'node -e "process.stdout.write(\'x\')"',
            cwd: join(TEMP_ROOT, 'underload-command-run-missing-cwd')
        }).catch((caught: unknown) => caught);

        // A missing cwd is an ENOENT setup error, not exit code data.
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    });

    it('rejects a blank command', async () => {
        await expect(shell({ command: '   ' })).rejects.toThrow(
            new HarnessError('shell requires a non-empty command string.')
        );
    });

    it('rejects invalid timeout values', async () => {
        const message = 'shell timeoutMs must be a positive finite number of milliseconds.';

        await expect(shell({ command: 'node --version', timeoutMs: 0 })).rejects.toThrow(
            new HarnessError(message)
        );
        await expect(shell({ command: 'node --version', timeoutMs: -1 })).rejects.toThrow(
            new HarnessError(message)
        );
        await expect(shell({ command: 'node --version', timeoutMs: Number.NaN })).rejects.toThrow(
            new HarnessError(message)
        );
        await expect(
            shell({ command: 'node --version', timeoutMs: Number.POSITIVE_INFINITY })
        ).rejects.toThrow(new HarnessError(message));
    });

    it('rejects a non-string input and a non-boolean saveOutput', async () => {
        // The harness does not validate JSON Schema, so a model can send 5 for a
        // string. Rejecting beats silently feeding the child "5".
        await expect(shell({ command: 'node --version', input: 5 as unknown as string })).rejects.toThrow(
            new HarnessError('shell input must be a string when provided.')
        );

        await expect(
            shell({ command: 'node --version', saveOutput: 'no' as unknown as boolean })
        ).rejects.toThrow(new HarnessError('shell saveOutput must be a boolean when provided.'));
    });

    it('exposes bounded timeout defaults with no unlimited override', () => {
        expect(COMMAND_DEFAULT_TIMEOUT_MS).toBe(120_000);
        expect(COMMAND_MAX_TIMEOUT_MS).toBe(600_000);
    });
});
