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
// The launcher serves the canonical root, and the assertion below must not drift from it: imported
// from the same module the launcher's adapter mounts on, rather than re-spelled here.
import { STANDALONE_MOUNT } from './api';
// The generated health envelope and route builders, so the launcher test states the target
// contract's fields rather than the implementation's current output.
import { HARNESS_ROUTES } from '../shared/harness-api';
import type { HarnessCardPage, HealthResponse } from '../shared/harness-api';

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

                // The API is live on the OS-assigned port, under the canonical root (there is no
                // `/api` mount any more, and the client-hint header is no longer required). The
                // envelope is the generated `HealthResponse`: liveness, the session count, and the
                // process EPOCH — the field the target contract added so a monitor detects a restart
                // without parsing a version string, and the same value the stream's `welcome` carries.
                const healthResponse = await fetch(`${url}${STANDALONE_MOUNT}/health`, { headers: CLIENT });
                expect(healthResponse.status).toBe(200);
                expect(healthResponse.headers.get('x-harness-epoch')).toBeTruthy();

                const health = (await healthResponse.json()) as HealthResponse;
                expect(health.ok).toBe(true);
                expect(health.sessions).toBe(0);
                expect(health.epoch).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);

                // The banner advertises the mount and the stream URL on the SAME host and port,
                // which is the point of not inventing a second listener for WebSocket.
                expect(stdout).toContain(`  API    ${url}${STANDALONE_MOUNT}`);
                expect(stdout).toContain(`  STREAM ${url.replace('http://', 'ws://')}${STANDALONE_MOUNT}/stream`);

                // staticRoot: null — the launcher is not a UI host.
                const root = await fetch(`${url}/`);
                expect(root.status).toBe(404);
                expect(await root.text()).toBe('Not found');

                // The only startup banner is the harness server's. A Vite dev
                // server would print `VITE ... Local: http://...`.
                expect(stdout).toContain(`Harness server listening at ${url}`);
                expect(stdout).not.toContain('VITE');
                expect(stdout).not.toContain('Local:');

                // The catalogue the launcher ships is the production one: SEVEN real,
                // runnable configurations (T5 + the roster/role-contract pass), no
                // scripted demo and no card that fails on purpose. This is the whole
                // point of the removal, so it is asserted against a REAL launched
                // server, not only against the store. The order is the contract: the
                // default card first, `debugger` last (../harnesses/presets.ts:486-494).
                // T18: the read is the contract's `HarnessCardPage` (`items` plus `PageMeta`), not the
                // legacy `{ harnesses }` index, and the route comes from the generated builders.
                const catalogue = await fetch(`${url}${HARNESS_ROUTES.harnesses()}`, { headers: CLIENT });
                expect(catalogue.status).toBe(200);
                const index = (await catalogue.json()) as HarnessCardPage;
                expect(index.items.map((harness) => harness.name)).toEqual([
                    'general',
                    'instruct',
                    'research',
                    'workspace',
                    'reviewer',
                    'planner',
                    'debugger',
                    // The tool-less card (issue 0005-D) is part of the shipped catalogue a
                    // standalone server serves, so the launcher's own listing pins it.
                    'chat'
                ]);

                // --database-root reached startHarnessServer: a session persists.
                // A shipped role is used (not the offline fixture, which this build no
                // longer lists); creating a session never contacts the provider, so the
                // child stays offline while still exercising the durable write.
                const created = await fetch(`${url}${STANDALONE_MOUNT}/sessions`, {
                    method: 'POST',
                    headers: { ...CLIENT, 'content-type': 'application/json' },
                    body: JSON.stringify({ harness: 'instruct' })
                });
                expect(created.status).toBe(201);

                const stateFile = path.join(databaseRoot, 'harness', 'state.json');
                expect(fs.existsSync(stateFile)).toBe(true);
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
                    version: number;
                    deleted?: string[];
                    sessions: { harness: string; status: string }[];
                };
                expect(state.version).toBe(1);
                expect(state.sessions).toHaveLength(1);
                expect(state.sessions[0]).toMatchObject({ harness: 'instruct', status: 'idle' });

                // Nothing was deleted, so the additive T5 field is absent: a document
                // written by this build keeps the pre-T5 shape.
                expect(state).not.toHaveProperty('deleted');
            } finally {
                await stop(child);
                fs.rmSync(work, { recursive: true, force: true });
            }
        },
        30_000
    );
});
