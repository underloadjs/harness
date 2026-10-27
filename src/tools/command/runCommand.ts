// runCommand — execute a shell command and collect its output.
//
// The escape hatch every CLI harness ships, and the most powerful tool here: it
// runs with the permissions of the host process and has NO sandbox, no allowlist,
// and no confirmation step. Treat it the way you would treat a terminal handed to
// the model — run the harness inside a container, a worktree, or an account you
// are willing to have modified.
//
// Executable on its own and registerable on a harness:
//
//     const { exitCode, stdout } = await runCommand({ command: 'git status' });

import { spawn } from 'node:child_process';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';

export type RunCommandResult = {
    // Process exit code, or -1 when the process was terminated by a signal.
    exitCode: number;
    stdout: string;
    stderr: string;
};

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const runCommand = tool<{ command: string; cwd?: string }, RunCommandResult>({
    ...PRESET_TOOLS.runCommand,
    execute: ({ parameters: { command, cwd } }) =>
        new Promise<RunCommandResult>((resolve, reject) => {
            // shell: true is deliberate — it is what makes a single string
            // behave like a command line instead of an argv array.
            const child = spawn(command, { cwd, shell: true });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (chunk) => {
                stdout += chunk;
            });

            child.stderr?.on('data', (chunk) => {
                stderr += chunk;
            });

            // Spawn failures (missing cwd, no shell) are real errors.
            child.on('error', reject);

            // A non-zero exit is a normal result: the model needs to see it to
            // decide what to do next, so it is returned rather than thrown.
            child.on('close', (code, signal) => {
                resolve({
                    exitCode: code ?? (signal ? -1 : 0),
                    stdout,
                    stderr
                });
            });
        })
});
