// Built-package runtime smoke: the artifact must WORK, not merely import.
//
// Why this exists: the published ES bundle is produced by a browser-platform lib
// build. Node builtins imported with the `node:` prefix were external, but bare
// `require('fs')`/`require('path')` from the bundled CommonJS dependency (`dotenv`)
// resolved to Vite's empty `__vite-browser-external` stub. The built
// `loadEnvironmentFile()` then threw `path.resolve is not a function`, which made
// `startHarnessServer()` — and every service route's `createHarnessRuntime()` —
// unusable in plain Node. Type declarations and import-safety checks cannot see that;
// this can.
//
// What it asserts:
//   0. the editable TypeScript source tree (`src/`) is packed beside portable
//      output (`dist/`), with no test files — the runtime compiler's inputs;
//   1. `loadEnvironmentFile()` reads a real file (the dotenv path);
//   2. `createHarnessRuntime({ root })` binds the durable database to that absolute
//      root, and a session created through its API persists under it;
//   3. `startHarnessServer({ databaseRoot, port: 0 })` serves the harness index and a
//      session POST over real HTTP, persists under that root, and closes its listener;
//   4. D4: the `./io-worker` subpath is published, its bundle exists, and the shipped entry
//      handshakes, commits a checkpoint, appends and fences a journal line IN A THREAD - after
//      which the built server's own reader loads what that thread wrote.
//
// Safety: loopback + port 0 only (never a fixed or production port), no signal
// handlers, no machine-environment changes, and no `.env` value is ever printed —
// only paths, status codes and booleans. Scratch lives under the repository-root
// Temp (`--scratch` overrides; see ./scratch.mjs) and is removed unless `--keep`.
//
// USAGE
//     node scripts/check-package-runtime.mjs                 # checks <package>/dist
//     node scripts/check-package-runtime.mjs --scratch <dir> --keep
//
// Run it after `yarn build`; `prepublishOnly` chains it via `test:package:runtime`.
//
// Cross-references:
//   - ../vite.config.ts              — the externalisation this regression guards
//   - ./package-files.mjs            — packed shape + source-beside-dist contract
//   - ./scratch.mjs                  — repository Temp scratch root
//   - ./check-package-types.mjs      — declaration/type counterpart
//   - ../package.json                — `test:package:runtime`

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// D4: the IO worker check spawns the SHIPPED entry in a real thread, exactly as
// ./src/server/workers/io-client.ts does in the running server.
import { Worker } from 'node:worker_threads';
import {
    BUILD_ROOT,
    EDITABLE_SOURCE_ROOT,
    PACKAGE_ROOT,
    publishedFiles,
    readPackageManifest
} from './package-files.mjs';
import { applyScratchEnvironment, resolveScratchRoot } from './scratch.mjs';

const DIST = path.join(PACKAGE_ROOT, BUILD_ROOT);

const fail = (message) => {
    console.error(`package runtime: ${message}`);
    process.exit(1);
};

if (!existsSync(path.join(DIST, 'underload-harness.server.mjs'))) {
    fail('dist/ has no server entry — run `yarn build` first');
}

const scratchRoot = resolveScratchRoot({ kind: 'package-runtime' });
applyScratchEnvironment(scratchRoot);
const keep = process.argv.includes('--keep');

const work = mkdtempSync(path.join(scratchRoot, 'run-'));

// Result bookkeeping. `check` awaits its callback so an async assertion cannot pass
// silently, and a throwing step is reported as a failure rather than a crash.
const results = [];
const check = async (name, fn) => {
    try {
        const detail = await fn();
        results.push({ name, ok: true });
        console.log(`  OK   ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    } catch (error) {
        results.push({ name, ok: false, error: String(error) });
        console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
};
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const importFromDist = (file) => import(pathToFileURL(path.join(DIST, file)).href);

const server = await importFromDist('underload-harness.server.mjs');
const nodeRoot = await importFromDist('underload-harness.mjs');

console.log('package runtime: built dist');

// The installed layout must expose editable TypeScript beside the generated
// build. A runtime compiler resolves that sibling path, so a published package
// containing only `dist/` would be unable to self-modify in production
// (tasks/task-harness-self-modifying-tools.md §2/§8).
await check('editable source tree ships beside dist', () => {
    const manifest = readPackageManifest(PACKAGE_ROOT);
    const published = publishedFiles({ root: PACKAGE_ROOT, manifest });
    const sourceRoot = path.join(PACKAGE_ROOT, EDITABLE_SOURCE_ROOT);
    const sourceEntry = path.join(sourceRoot, 'index.ts');

    assert(existsSync(sourceRoot), `${EDITABLE_SOURCE_ROOT}/ is missing beside ${BUILD_ROOT}/`);
    assert(existsSync(sourceEntry), `${EDITABLE_SOURCE_ROOT}/index.ts is missing`);
    assert(
        path.dirname(sourceRoot) === path.dirname(DIST),
        `${EDITABLE_SOURCE_ROOT}/ and ${BUILD_ROOT}/ are not siblings`
    );

    const sourceFiles = published.filter((file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/`));
    const tests = sourceFiles.filter((file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file));
    assert(sourceFiles.length > 0, 'the manifest does not publish src/');
    assert(tests.length === 0, `test files are published as source: ${tests.slice(0, 3).join(', ')}`);

    return { source: EDITABLE_SOURCE_ROOT, files: sourceFiles.length };
});

await check('server entry exports the reusable API', () => ({
    startHarnessServer: typeof server.startHarnessServer,
    createHarnessRuntime: typeof server.createHarnessRuntime,
    loadEnvironmentFile: typeof server.loadEnvironmentFile
}));
await check('Node root shares the same server API', () => {
    assert(nodeRoot.startHarnessServer === server.startHarnessServer, 'the root re-exports a different function');
    return true;
});

// 1. The dotenv path (the stub regression). The CALL is inside the check so a
// throwing bundled dependency is reported as a failure, not an uncaught crash.
const fixture = path.join(work, '.env.fixture');
writeFileSync(fixture, 'HARNESS_PACKAGE_RUNTIME_FIXTURE=ok\n', 'utf8');
await check('loadEnvironmentFile reads a real file', () => {
    const environment = {};
    const loaded = server.loadEnvironmentFile({ path: fixture, environment });

    assert(loaded.loaded === true, 'the environment file was not read');
    assert(environment.HARNESS_PACKAGE_RUNTIME_FIXTURE === 'ok', 'the parsed value is missing');
    return { loaded: true, keys: Object.keys(environment).length };
});

// 2. Durable runtime bound to an absolute root (creation + first write in one check,
// so a throw is reported instead of escaping).
const runtimeRoot = path.join(work, 'runtime-root');
await check('createHarnessRuntime persists a session under the requested root', async () => {
    assert(path.isAbsolute(runtimeRoot), 'the test root must be absolute');

    const runtime = server.createHarnessRuntime({ root: runtimeRoot, loadEnvironment: false });
    assert(runtime.root === path.resolve(runtimeRoot), 'runtime.root is not the requested root');
    assert(typeof runtime.persistence === 'object', 'no persistence bound');

    const created = await runtime.api({
        method: 'POST',
        pathname: '/v1/harness/sessions',
        mount: '/v1/harness',
        readBody: async () => ({ harness: 'demo' })
    });
    assert(created.kind === 'json' && created.status === 201, 'the runtime API did not create a session');

    const database = path.join(runtimeRoot, 'harness', 'state.json');
    assert(existsSync(database), 'no database file under the runtime root');
    assert(readFileSync(database, 'utf8').includes('"sessions"'), 'the database has no sessions section');

    return { status: created.status, database: path.relative(work, database) };
});

// 3. A real listener on an ephemeral loopback port. The whole exchange is one check
// so a thrown fetch/server error is reported instead of escaping.
const serverRoot = path.join(work, 'server-root');
const CLIENT = { 'X-Harness-Client': 'ui' };
let handle;
try {
    await check('startHarnessServer serves the standalone API on an ephemeral port', async () => {
        handle = await server.startHarnessServer({
            host: '127.0.0.1',
            port: 0,
            staticRoot: null,
            databaseRoot: serverRoot
        });

        assert(handle.port > 0, 'no port was assigned');
        assert(handle.url.startsWith('http://127.0.0.1:'), 'the url is not loopback');

        const health = await fetch(`${handle.url}/api/health`, { headers: CLIENT });
        assert(health.status === 200, `/api/health returned ${health.status}`);

        const harnesses = await fetch(`${handle.url}/api/harnesses`, { headers: CLIENT });
        const index = await harnesses.json();
        assert(harnesses.status === 200, `/api/harnesses returned ${harnesses.status}`);

        const names = index.harnesses.map((entry) => entry.name);
        assert(names.includes('demo'), 'the demo preset is missing from the harness index');

        const session = await fetch(`${handle.url}/api/sessions`, {
            method: 'POST',
            headers: { ...CLIENT, 'content-type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });
        const sessionBody = await session.json();
        assert(session.status === 201, `/api/sessions returned ${session.status}`);
        assert(sessionBody.session?.harness === 'demo', 'the created session is not the demo harness');

        return { url: handle.url, presets: names.length, session: session.status };
    });
} finally {
    if (handle !== undefined) {
        const url = handle.url;
        await handle.close();

        await check('listener closed', async () => {
            const state = await fetch(`${url}/api/health`, { headers: CLIENT }).then(
                () => 'still listening',
                () => 'closed'
            );
            assert(state === 'closed', state);
            return state;
        });
        await check('server session persisted under the database root', () => {
            const database = path.join(serverRoot, 'harness', 'state.json');
            assert(existsSync(database), 'no database file under databaseRoot');
            return path.relative(work, database);
        });
    }
}

// 4. D4: the IO worker EXECUTABLE. A second shipped entry means a second artifact that must
// actually RUN in a thread: importing cleanly proves nothing, and `sideEffects: false` makes a
// tree-shaken entry that never answers `hello` a real failure mode (measured during T9). This
// drives the built bundle the way ./src/server/workers/io-client.ts does - boot marker in
// `workerData`, `hello`, one checkpoint, one journal append + fence - and then makes the built
// SERVER read what the built WORKER wrote.
const IO_WORKER_FILE = 'underload-harness.io-worker.mjs';

// Mirrors ./src/server/workers/io-protocol.ts (`IO_PROTOCOL_VERSION`, `IO_WORKER_BOOT_KEY`).
// ./src/structure.test.ts pins the manifest half of the pairing, so a rename on one side fails
// a check rather than producing a server that silently persists on its own loop.
const IO_PROTOCOL_VERSION = 1;
const IO_BOOT_KEY = 'harnessIoWorker';

await check('the io-worker entry is published as its own subpath', () => {
    const manifest = readPackageManifest(PACKAGE_ROOT);
    const entry = manifest.exports?.['./io-worker'];

    assert(entry !== undefined, '`exports` has no "./io-worker" subpath');
    assert(entry.import === `./${BUILD_ROOT}/${IO_WORKER_FILE}`, `./io-worker does not resolve to ${BUILD_ROOT}/${IO_WORKER_FILE}: ${JSON.stringify(entry)}`);
    assert(typeof entry.types === 'string' && entry.types.endsWith('.d.ts'), './io-worker declares no .d.ts target');
    assert(existsSync(path.join(DIST, IO_WORKER_FILE)), `dist/${IO_WORKER_FILE} is missing — vite.config.ts must keep the "io-worker" library entry`);
    assert(existsSync(path.join(DIST, 'server', 'workers', 'io-worker.d.ts')), 'the io-worker declaration was not emitted');

    return { runtime: entry.import, types: entry.types };
});

const ioRoot = path.join(work, 'io-root');
const ioDirectory = path.join(ioRoot, 'harness');
const ioState = path.join(ioDirectory, 'state.json');
const ioSession = 'io-smoke-session';

await check('the built io-worker commits, journals and fences off-thread', async () => {
    // A `URL`, not a `file://` string: Node rejects the string form. This mirrors
    // ./src/server/workers/io-client.ts, which spawns with `pathToFileURL(entry)`.
    const worker = new Worker(pathToFileURL(path.join(DIST, IO_WORKER_FILE)), {
        // The boot marker is what makes the entry self-start its message loop at all; without it
        // the thread imports, answers nothing, and exits 0.
        workerData: { [IO_BOOT_KEY]: IO_PROTOCOL_VERSION, maxFrameBytes: 4 * 1024 * 1024 }
    });

    try {
        // One frame in, one reply out, matched by kind AND callId: the ordering contract, asserted
        // against the shipped bundle rather than a source file.
        const call = (frame) =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error(`the io-worker never answered ${frame.kind}`));
                }, 60_000);

                worker.once('error', (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                worker.once('message', (reply) => {
                    clearTimeout(timer);
                    resolve(reply);
                });
                worker.postMessage(frame);
            });

        const hello = await call({ kind: 'hello', callId: 0 });

        assert(hello.kind === 'hello' && hello.ok === true && hello.version === IO_PROTOCOL_VERSION, `handshake: ${JSON.stringify(hello)}`);

        const saved = await call({
            kind: 'checkpoint.save',
            callId: 1,
            target: { directory: ioDirectory, file: ioState },
            document: { version: IO_PROTOCOL_VERSION, savedAt: 1_700_000_000_000, registry: [], sessions: [] },
            savedAt: 1_700_000_000_000
        });

        // A checkpoint answers 'durable': fsynced staging plus atomic rename, never a partial
        // write (./src/server/persistence.ts is the only writer of this format).
        assert(saved.kind === 'result' && saved.ok === true && saved.outcome === 'durable', `checkpoint.save: ${JSON.stringify(saved)}`);

        for (const frame of [
            { kind: 'journal.open', callId: 2, target: { root: ioDirectory, sessionId: ioSession } },
            {
                kind: 'journal.append',
                callId: 3,
                target: { root: ioDirectory, sessionId: ioSession },
                record: { turnId: 'turn-1', index: 0, at: 1_700_000_000_001, event: { type: 'text', agent: 'demo', delta: 'from the built bundle' } }
            },
            { kind: 'journal.flush', callId: 4, target: { root: ioDirectory, sessionId: ioSession } }
        ]) {
            const reply = await call(frame);

            assert(reply.kind === 'result' && reply.ok === true, `${frame.kind}: ${JSON.stringify(reply)}`);
        }

        const bye = await call({ kind: 'shutdown', callId: 5 });

        assert(bye.kind === 'bye' && bye.ok === true, `shutdown: ${JSON.stringify(bye)}`);

        // RELOAD, by the built server's own readers: the checkpoint parses as a database, and the
        // journal file holds the header line plus exactly the event the worker was told to write.
        const runtime = server.createHarnessRuntime({ root: ioRoot, loadEnvironment: false });

        assert(runtime.persistence !== undefined, 'the built runtime bound no persistence');

        const loaded = runtime.persistence.load();

        assert(loaded?.version === IO_PROTOCOL_VERSION, 'the worker-written document did not load');
        assert(Array.isArray(loaded.sessions) && loaded.sessions.length === 0, 'the reloaded sessions array is wrong');
        assert(runtime.persistence.lastWriteError === undefined, `lastWriteError: ${runtime.persistence.lastWriteError}`);

        const lines = readFileSync(path.join(ioDirectory, 'sessions', ioSession, 'events.jsonl'), 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line));

        assert(lines[0]?.type === 'header' && lines[0].sessionId === ioSession, `journal header: ${JSON.stringify(lines[0])}`);
        assert(lines[1]?.type === 'event' && lines[1].event?.delta === 'from the built bundle', `journal event: ${JSON.stringify(lines[1])}`);

        return { bytes: saved.bytes, journalLines: lines.length };
    } finally {
        await worker.terminate();
    }
});

if (!keep) rmSync(work, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
    fail(`${failed.length} check(s) failed: ${failed.map((result) => result.name).join(', ')}`);
}

console.log(`package runtime: ${results.length} check(s) OK`);
