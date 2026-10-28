// commandRun — the bounded shell escape hatch (R1).
//
// What this pins, exactly:
//   - ordinary small commands return the real exit code and exact captured text;
//   - a non-zero exit stays DATA (it is not thrown);
//   - stdout/stderr are capped at 128 KiB / 16 KiB with an explicit `truncated`
//     flag, and the tail is dropped;
//   - UTF-8 split across stream chunks is decoded intact (the old `text += chunk`
//     concatenation corrupted it);
//   - a timeout and an AbortSignal both terminate the run and report
//     `timedOut`/`aborted` with exitCode -1;
//   - spawn/setup failures (a missing cwd here) reject instead of being reported
//     as a command result; blank commands and invalid timeout values are refused.
//
// Every command is a real child process running `node -e …`, so the assertions
// describe the actual shell and stream behaviour rather than a mock. Fixtures are
// unnecessary: the commands print fixed strings.

import { afterAll, describe, expect, it } from 'vitest';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    COMMAND_DEFAULT_TIMEOUT_MS,
    COMMAND_MAX_TIMEOUT_MS,
    commandRun,
    type CommandRunParameters
} from './commandRun';
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
    commandRun.execute({ parameters, signal } as unknown as Parameters<typeof commandRun.execute>[0]);

describe('commandRun', () => {
    it('returns the exact result for a small command', async () => {
        await expect(commandRun({ command: 'node -e "process.stdout.write(\'hello\')"' })).resolves.toEqual({
            exitCode: 0,
            stdout: 'hello',
            stderr: '',
            truncated: false,
            timedOut: false,
            aborted: false
        });
    });

    it('captures stderr separately from stdout', async () => {
        await expect(
            commandRun({ command: 'node -e "process.stderr.write(\'boom\')"' })
        ).resolves.toEqual({
            exitCode: 0,
            stdout: '',
            stderr: 'boom',
            truncated: false,
            timedOut: false,
            aborted: false
        });
    });

    it('returns a non-zero exit as data instead of throwing', async () => {
        await expect(commandRun({ command: 'node -e "process.exit(3)"' })).resolves.toEqual({
            exitCode: 3,
            stdout: '',
            stderr: '',
            truncated: false,
            timedOut: false,
            aborted: false
        });
    });

    it('decodes a UTF-8 codepoint split across stream chunks', async () => {
        // U+20AC (E2 82 AC) is written as two buffers in separate ticks, so the
        // child really does emit it across two 'data' chunks.
        const command =
            'node -e "process.stdout.write(Buffer.from([0xE2,0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xAC])), 100)"';

        await expect(commandRun({ command })).resolves.toEqual({
            exitCode: 0,
            stdout: '€',
            stderr: '',
            truncated: false,
            timedOut: false,
            aborted: false
        });
    });

    it('caps stdout at 128 KiB and flags truncation', async () => {
        const result = await commandRun({ command: 'node -e "process.stdout.write(\'a\'.repeat(200000))"' });

        expect(result.exitCode).toBe(0);
        // ASCII only, so the byte cap and the string length agree exactly.
        expect(result.stdout.length).toBe(COMMAND_STDOUT_MAX_BYTES);
        expect(result.stderr).toBe('');
        expect(result.truncated).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.aborted).toBe(false);
    });

    it('caps stderr at 16 KiB and flags truncation', async () => {
        const result = await commandRun({ command: 'node -e "process.stderr.write(\'b\'.repeat(20000))"' });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr.length).toBe(COMMAND_STDERR_MAX_BYTES);
        expect(result.truncated).toBe(true);
    });

    it('times out a long run, kills it, and reports the flags', async () => {
        const result = await commandRun({
            command: 'node -e "setTimeout(() => {}, 5000)"',
            timeoutMs: 150
        });

        expect(result).toEqual({
            exitCode: -1,
            stdout: '',
            stderr: '',
            truncated: false,
            timedOut: true,
            aborted: false
        });
    });

    it('kills the shell GRANDCHILD on timeout (delayed marker never appears)', async () => {
        // Regression for the win32 ordering bug: taskkill was spawned and the
        // shell killed immediately, so taskkill lost the descendant and node.exe
        // survived long enough to write after the 200 ms timeout.
        const path = markerPath('timeout.txt');
        await rm(path, { force: true });

        const result = await commandRun({ command: markerCommand(path, 1500), timeoutMs: 200 });

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

            expect(result).toEqual({
                exitCode: -1,
                stdout: '',
                stderr: '',
                truncated: false,
                timedOut: false,
                aborted: true
            });
        } finally {
            clearTimeout(timer);
        }
    });

    it('does not spawn when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            executeWithSignal({ command: 'node -e "process.stdout.write(\'never\')"' }, controller.signal)
        ).resolves.toEqual({
            exitCode: -1,
            stdout: '',
            stderr: '',
            truncated: false,
            timedOut: false,
            aborted: true
        });
    });

    it('rejects a spawn failure instead of reporting it as a result', async () => {
        const error = await commandRun({
            command: 'node -e "process.stdout.write(\'x\')"',
            cwd: join(TEMP_ROOT, 'underload-command-run-missing-cwd')
        }).catch((caught: unknown) => caught);

        // A missing cwd is an ENOENT setup error, not exit code data.
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    });

    it('rejects a blank command', async () => {
        await expect(commandRun({ command: '   ' })).rejects.toThrow(
            new HarnessError('commandRun requires a non-empty command string.')
        );
    });

    it('rejects invalid timeout values', async () => {
        const message = 'commandRun timeoutMs must be a positive finite number of milliseconds.';

        await expect(commandRun({ command: 'node --version', timeoutMs: 0 })).rejects.toThrow(
            new HarnessError(message)
        );
        await expect(commandRun({ command: 'node --version', timeoutMs: -1 })).rejects.toThrow(
            new HarnessError(message)
        );
        await expect(commandRun({ command: 'node --version', timeoutMs: Number.NaN })).rejects.toThrow(
            new HarnessError(message)
        );
        await expect(
            commandRun({ command: 'node --version', timeoutMs: Number.POSITIVE_INFINITY })
        ).rejects.toThrow(new HarnessError(message));
    });

    it('exposes bounded timeout defaults with no unlimited override', () => {
        expect(COMMAND_DEFAULT_TIMEOUT_MS).toBe(120_000);
        expect(COMMAND_MAX_TIMEOUT_MS).toBe(600_000);
    });
});
