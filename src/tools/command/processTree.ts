// terminateTree — end a child process AND the tree it started.
//
// `child.kill()` is not enough for either command tool:
//   - commandRun uses `shell: true`, so the direct child is cmd.exe/sh. Killing
//     the shell can leave the real command running and holding the pipes, and the
//     'close' event then never fires;
//   - gitDiff disables external drivers, but git itself may still start helpers.
//
// Platform strategy:
//   - POSIX: spawn the child as its own process GROUP (see processGroupOptions),
//     then signal the whole group with -pid. Falls back to child.kill() when the
//     group is already gone or the platform refuses the negative pid. This is
//     synchronous and unchanged.
//   - Windows: `taskkill /T /F` walks the tree; there is no POSIX group to signal
//     and Node exposes no job-object API. ORDER IS CRITICAL: taskkill must be
//     ALLOWED TO FINISH before the root is killed. Killing cmd.exe first (the old
//     behaviour) destroyed the parent before taskkill could enumerate its
//     descendants, so a grandchild survived and later wrote its marker. This
//     function therefore AWAITS taskkill's own 'close' (bounded by
//     TASKKILL_TIMEOUT_MS) and only then falls back to child.kill() as a root
//     guarantee.
//
// Resolution: the promise resolves only once the Windows taskkill attempt has
// completed (or timed out) and the fallback root kill has been issued. Callers
// (./commandRun, ./gitDiff, ../syntax/python) await it before settling a
// timeout/abort result, so a tool result cannot be reported while the tree kill
// is still in flight. LIMITATION, stated honestly: `taskkill /T` is still
// best-effort — a descendant that changed its parent pid (or was reparented) is
// not in the tree — but the enumeration race that lost the node.exe grandchild is
// closed.
//
// Cross-references:
//   - ./commandRun — timeout and AbortSignal both await terminateTree
//   - ./gitDiff    — same, for the fixed git argv
//   - ../syntax/python — awaits it on timeout/abort

import { spawn, type ChildProcess } from 'node:child_process';

// How long taskkill may take before the fallback root kill is issued anyway.
// Normal runs finish in tens of milliseconds; this only bounds a hung taskkill.
const TASKKILL_TIMEOUT_MS = 2_000;

// Spawn options every command tool passes:
//   - windowsHide: no console window flashes for the child or taskkill;
//   - detached (POSIX only): the child leads a new process group, which is what
//     makes a single `process.kill(-pid)` able to reach the whole tree. Detached
//     on Windows would create a new console, so it is deliberately off there.
export const processGroupOptions = (): { windowsHide: boolean; detached: boolean } => ({
    windowsHide: true,
    detached: process.platform !== 'win32'
});

export const terminateTree = (child: ChildProcess): Promise<void> => {
    const pid = child.pid;

    // No pid means the spawn never completed; there is nothing to signal.
    if (pid === undefined) return Promise.resolve();

    if (process.platform !== 'win32') {
        try {
            // Negative pid = the POSIX process group created by detached:true.
            process.kill(-pid, 'SIGKILL');
        } catch {
            try {
                child.kill('SIGKILL');
            } catch {
                // Already closed.
            }
        }

        return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (): void => {
            if (settled) return;

            settled = true;
            if (timer) clearTimeout(timer);

            // Fallback root kill, AFTER taskkill has finished (or timed out). Never
            // before: killing the root first hides the descendants from taskkill.
            try {
                child.kill();
            } catch {
                // Already closed.
            }

            resolve();
        };

        let killer: ChildProcess;

        try {
            killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true
            });
        } catch {
            // taskkill could not be started at all; the fallback still reports
            // completion.
            finish();
            return;
        }

        killer.on('error', finish);
        killer.on('close', finish);

        // Bounded backstop: a hung taskkill must not block cancellation forever.
        timer = setTimeout(() => {
            try {
                killer.kill();
            } catch {
                // Already exited.
            }

            finish();
        }, TASKKILL_TIMEOUT_MS);
    });
};
