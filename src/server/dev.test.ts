// The explicit standalone server launcher (`yarn dev:server`), exercised as a
// real child process.
//
// Why spawn instead of importing: `src/server/dev.ts` is an executable entry that
// waits for signals and never returns, exactly like `src/server/cli/index.ts`. A
// child process is the only faithful way to assert its observable contract:
//
//   1. it binds the harness API on an ephemeral loopback port;
//   2. it serves NO UI/static files (`/` is 404) and starts no Vite banner;
//   3. `--database-root` is forwarded to `startHarnessServer`, so a created session
//      persists under `<root>/harness/state.json`.
//
// Safety: loopback + port 0 only, a database root under the repo-root Temp/ (never
// the package tree or a production root), and the child is terminated in a finally
// block. `vite-node` is resolved through the package dependency graph so the test
// also works in the standalone harness repository (not only this workspace).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/server -> package root is two levels up.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
// All scratch lives in the repo-root Temp/, per AGENTS.md.
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp', 't-launch-split');

// The package's own devDependency, resolved from this module rather than assumed
// to be at a particular workspace level.
const require = createRequire(import.meta.url);
const VITE_NODE = path.join(path.dirname(require.resolve('vite-node/package.json')), 'dist', 'cli.mjs');

const CLIENT = { 'X-Harness-Client': 'ui' };

// Wait for the launcher's startup line and return the bound URL. Polling keeps the
// helper independent of chunk boundaries in the child's stdout.
const waitForUrl = async (
    child: ReturnType<typeof spawn>,
    stdout: () => string,
    stderr: () => string
): Promise<string> => {
    const deadline = Date.now() + 25_000;

    while (Date.now() < deadline) {
        const match = stdout().match(/Harness server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match !== null) return match[1];

        if (child.exitCode !== null) {
            throw new Error(`the launcher exited with ${child.exitCode}: ${stderr()}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`the launcher did not start in time: ${stderr()}`);
};

// Terminate and await the child so the Temp database can be removed on Windows.
const stop = async (child: ReturnType<typeof spawn>): Promise<void> => {
    if (child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
        }, 5_000);

        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });

        child.kill();
    });
};

describe('standalone server launcher', () => {
    it(
        'serves the API only and forwards --database-root',
        async () => {
            fs.mkdirSync(TEMP_ROOT, { recursive: true });
            const work = path.join(TEMP_ROOT, `harness-dev-${process.pid}-${Date.now()}`);
            const databaseRoot = path.join(work, 'database');
            fs.mkdirSync(work, { recursive: true });

            const child = spawn(
                process.execPath,
                [
                    VITE_NODE,
                    'src/server/dev.ts',
                    '--port',
                    '0',
                    '--host',
                    '127.0.0.1',
                    '--database-root',
                    databaseRoot
                ],
                { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
            );

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString('utf8');
            });

            try {
                const url = await waitForUrl(child, () => stdout, () => stderr);
                expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

                // The API is live on the OS-assigned port.
                const health = await fetch(`${url}/api/health`, { headers: CLIENT });
                expect(health.status).toBe(200);
                expect(await health.json()).toEqual({ ok: true, sessions: 0 });

                // staticRoot: null — the launcher is not a UI host.
                const root = await fetch(`${url}/`);
                expect(root.status).toBe(404);
                expect(await root.text()).toBe('Not found');

                // The only startup banner is the harness server's. A Vite dev
                // server would print `VITE ... Local: http://...`.
                expect(stdout).toContain(`Harness server listening at ${url}`);
                expect(stdout).not.toContain('VITE');
                expect(stdout).not.toContain('Local:');

                // --database-root reached startHarnessServer: a session persists.
                const created = await fetch(`${url}/api/sessions`, {
                    method: 'POST',
                    headers: { ...CLIENT, 'content-type': 'application/json' },
                    body: JSON.stringify({ harness: 'demo' })
                });
                expect(created.status).toBe(201);

                const stateFile = path.join(databaseRoot, 'harness', 'state.json');
                expect(fs.existsSync(stateFile)).toBe(true);
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
                    version: number;
                    sessions: { harness: string; status: string }[];
                };
                expect(state.version).toBe(1);
                expect(state.sessions).toHaveLength(1);
                expect(state.sessions[0]).toMatchObject({ harness: 'demo', status: 'idle' });
            } finally {
                await stop(child);
                fs.rmSync(work, { recursive: true, force: true });
            }
        },
        30_000
    );
});
