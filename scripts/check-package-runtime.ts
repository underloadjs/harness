// Published-package runtime smoke: the artifact must WORK, not merely import.
//
// WHY THIS EXISTS
// The source suite runs the repository tree through the same runner that wrote it. This
// check copies the PUBLISHED shape (manifest + resolved `files`) into a scratch install
// and runs THAT, so what is proven is the layout a consumer gets — including the two
// things a source-only publish makes easy to break:
//
//   1. the packed tree must actually execute. `exports` names `src/*.ts`, so a shipped
//      file that fails to load (a missing sibling, a path assumed relative to `dist/`,
//      a devDependency pulled into runtime code) is a broken release rather than a
//      suite failure;
//   2. the worker EXECUTABLES must survive packing. `src/server/workers/worker-boot.mjs`
//      is the one JS file the package ships, because `node:worker_threads` loads its
//      entry with raw Node; if it is not published, every worker-spawning host loses
//      durability with no in-repo test to notice.
//
// WHAT USED TO BE HERE, AND WHERE IT WENT
// ---------------------------------------
// This script used to import `dist/underload-harness.server.mjs` and to guard the
// bundling regression that the browser-platform lib build created: bare
// `require('fs')`/`require('path')` from the bundled CommonJS dependency (`dotenv`)
// resolved to Vite's empty `__vite-browser-external` stub, so the built
// `loadEnvironmentFile()` threw `path.resolve is not a function` and
// `startHarnessServer()` failed at its first line. Under source-only publishing there
// is no bundle and no browser-platform resolution: `dotenv` is imported by Node under
// Node's own CJS interop, so the stub regression cannot recur. Its RUNTIME
// consequence is still asserted here — `loadEnvironmentFile()` really parses a real
// file — because that is what a reader of the published source depends on.
//
// What it asserts:
//   0. the packed shape is the installed shape: editable TypeScript only (no `dist/`,
//      no emitted declaration, one JS bootstrap), with the entries the manifest names;
//   1. `loadEnvironmentFile()` reads a real file (the dotenv path);
//   2. `createHarnessRuntime({ root })` binds the durable database to that absolute
//      root, and a session created through its API persists under it;
//   3. `startHarnessServer({ databaseRoot, port: 0 })` serves the harness index and a
//      session POST over real HTTP, persists under that root, and closes its listener;
//   4. D4: `./io-worker` resolves to the published `.ts` entry and the shipped
//      bootstrap handshakes, commits a checkpoint, appends and fences a journal line IN
//      A THREAD — after which the published server's own reader loads what that thread
//      wrote.
//
// Safety: loopback + port 0 only (never a fixed or production port), no signal
// handlers, no machine-environment changes, and no `.env` value is ever printed —
// only paths, status codes and booleans. Scratch lives under the repository-root
// Temp (`--scratch` overrides; see ./scratch.ts) and is removed unless `--keep`.
//
// USAGE
//     yarn vite-node scripts/check-package-runtime.ts        # no build step needed
//     yarn vite-node scripts/check-package-runtime.ts --scratch <dir> --keep
//
// It runs under vite-node on purpose: the modules it imports are `.ts`, which is what
// root AGENTS.md prescribes (and the only way a consumer evaluates them).
//
// Cross-references:
//   - ./package-files.ts           — packed shape + the source-only artifact rules
//   - ./scratch.ts                 — repository Temp scratch root
//   - ./check-package-types.ts     — declaration/type counterpart of the same contract
//   - ./check-package-tools.ts     — self-modifying-tools scenario on the same copy
//   - src/server/workers/io-client.ts — the real client this smoke mirrors (spawn shape)
//   - ../package.json              — `test:package:runtime`

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// D4: the IO worker check spawns the SHIPPED bootstrap in a real thread, exactly as
// ./src/server/workers/io-client.ts does in the running server.
import { Worker } from 'node:worker_threads';
import {
    EDITABLE_SOURCE_ROOT,
    PACKAGE_ROOT,
    PERMITTED_BUILD_ARTIFACT,
    copyPublishedPackage,
    isBuiltArtifact,
    publishedFiles,
    readPackageManifest
} from './package-files.ts';
import { applyScratchEnvironment, resolveScratchRoot } from './scratch.ts';

// A failed smoke is one message plus exit 1, never a stack: the reader needs the
// check that failed, not a vite-node trace.
const fail = (message: string): never => {
    console.error(`package runtime: ${message}`);
    process.exit(1);
};

const scratchRoot = resolveScratchRoot({ kind: 'package-runtime' });
applyScratchEnvironment(scratchRoot);
const keep = process.argv.includes('--keep');

const work = mkdtempSync(path.join(scratchRoot, 'run-'));

// The installed layout under test: manifest + the resolved `files` payload. It is NOT
// inside a `node_modules` segment on purpose — the copy is imported by absolute path
// (this script is the consumer), and keeping the path free of `node_modules` is what
// makes the runner transform it as first-party source instead of treating it as an
// already-built dependency.
const packageRoot = path.join(work, 'package');
const manifest = readPackageManifest(PACKAGE_ROOT);
const published = publishedFiles({ root: PACKAGE_ROOT, manifest });
const copied = copyPublishedPackage({ sourceRoot: PACKAGE_ROOT, targetRoot: packageRoot, manifest, entries: published });

// npm always includes the root manifest; `copyPublishedPackage` models `files` only, so
// the manifest is written explicitly. Without it, module resolution and package-root
// discovery from the installed copy would not reflect a real install.
writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest, null, 4), 'utf8');

// A production install has the declared runtime dependencies next to the package. Link
// exactly the `dependencies` entries from the already-installed tree (no network), the
// same way ./check-package-tools.ts does, so nothing here resolves by accident through
// an ancestor of the repository.
const dependencyNames = Object.keys(manifest.dependencies ?? {});
for (const dependency of dependencyNames) {
    let current = PACKAGE_ROOT;
    let target: string | undefined;

    while (target === undefined) {
        const candidate = path.join(current, 'node_modules', dependency);
        if (existsSync(path.join(candidate, 'package.json'))) target = candidate;
        else {
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }

    if (target === undefined) fail(`runtime dependency "${dependency}" is not installed — run the package install first`);

    const link = path.join(packageRoot, 'node_modules', dependency);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target as string, link, process.platform === 'win32' ? 'junction' : 'dir');
}

// Result bookkeeping. `check` awaits its callback so an async assertion cannot pass
// silently, and a throwing step is reported as a failure rather than a crash.
// `error` stays `string` (never `Error`) so the summary line prints identically for
// thrown non-Error values coming out of the published runtime.
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
const check = async (name: string, fn: () => unknown): Promise<void> => {
    try {
        const detail = await fn();
        results.push({ name, ok: true });
        console.log(`  OK   ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    } catch (error) {
        results.push({ name, ok: false, error: String(error) });
        console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
};
// Assertion helpers are typed as TS assertion functions so a failing contract still
// throws the one-line message, while a passing one narrows unions for the reads below.
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) throw new Error(message);
};

// The published entries are untyped `.ts` modules to this script: `import()` through the
// vite-node runner gives `any`, which is exactly what a runtime smoke needs, because
// every member access below is an assertion about the shipped API rather than something
// the compiler can verify against a copy in scratch space.
const importPublished = async (relative: string): Promise<any> => {
    const entry = path.join(packageRoot, relative);
    assert(existsSync(entry), `${relative} is not in the packed shape`);
    return import(pathToFileURL(entry).href);
};

// 0. The packed shape is a source-only install.
await check('packed shape is editable source plus the one JS bootstrap', () => {
    const copiedSet = new Set(copied);
    const sourceFiles = copied.filter((file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/`));
    const tests = sourceFiles.filter((file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file));
    const built = sourceFiles.filter((file) => isBuiltArtifact(file, copiedSet));

    assert(sourceFiles.length > 0, 'the manifest does not publish src/');
    assert(tests.length === 0, `test files are published as source: ${tests.slice(0, 3).join(', ')}`);
    assert(built.length === 0, `the install carries a built artifact: ${built.join(', ')}`);
    // The worker bootstrap is a packaging requirement, not an optional extra.
    assert(
        sourceFiles.includes(PERMITTED_BUILD_ARTIFACT),
        `${PERMITTED_BUILD_ARTIFACT} is missing, so no host can spawn a worker thread`
    );
    // Nothing that used to be the payload may come back.
    assert(!existsSync(path.join(packageRoot, 'dist')), 'the install has a dist/ — the package publishes source');

    // And nothing the manifest points at may live there: this smoke imports the copied
    // entries by PATH, so a condition that drifted back to `dist/underload-harness.server.mjs`
    // or an emitted `index.d.ts` would install an unloadable path while every import here
    // still succeeded. Every target must be a packed source file.
    const collectTargets = (value: unknown): string[] =>
        Object.entries((value ?? {}) as Record<string, unknown>).flatMap(([, entry]) =>
            typeof entry === 'string' ? [entry] : collectTargets(entry)
        );

    const publishedTargets = [
        ...collectTargets(manifest.exports),
        manifest.main,
        manifest.module,
        manifest.types
    ]
        .filter((target): target is string => typeof target === 'string')
        .map((target) => target.replace(/^\.\//, ''))
        // `./package.json` is always packed and is not part of the `files` walk.
        .filter((target) => target !== 'package.json');

    const builtTargets = publishedTargets.filter((target) => isBuiltArtifact(target, copiedSet));
    assert(builtTargets.length === 0, `a published condition resolves to a built artifact: ${builtTargets.join(', ')}`);

    const missingTargets = publishedTargets.filter((target) => !copiedSet.has(target));
    assert(missingTargets.length === 0, `a published condition resolves outside the packed shape: ${missingTargets.join(', ')}`);

    return { files: copied.length, source: sourceFiles.length, targets: publishedTargets.length };
});

const server = await importPublished(`${EDITABLE_SOURCE_ROOT}/server/index.ts`);
const nodeRoot = await importPublished(`${EDITABLE_SOURCE_ROOT}/index.ts`);

console.log('package runtime: published source');

// The runtime compiler resolves its sources through
// `fileURLToPath(new URL('../src/', import.meta.url))`, i.e. the package root is the
// parent of the module that loads it. In a source-only install that is the SAME tree
// the entries are imported from, so the check is about the copy, not about a sibling.
await check('the copy resolves its own editable source root', () => {
    const sourceRoot = path.join(packageRoot, EDITABLE_SOURCE_ROOT);

    assert(existsSync(path.join(sourceRoot, 'index.ts')), `${EDITABLE_SOURCE_ROOT}/index.ts is missing`);
    assert(existsSync(path.join(sourceRoot, 'tools', 'runtime', 'toolRegistry.tool.ts')), 'the runtime tool sources are missing');

    return { source: EDITABLE_SOURCE_ROOT };
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

// 1. The dotenv path. The CALL is inside the check so a throwing dependency is
// reported as a failure, not an uncaught crash.
const fixture = path.join(work, '.env.fixture');
writeFileSync(fixture, 'HARNESS_PACKAGE_RUNTIME_FIXTURE=ok\n', 'utf8');
await check('loadEnvironmentFile reads a real file', () => {
    // The module fills this record in place; `Record<string, string>` is the shape
    // `loadEnvironmentFile` documents (../src/core/environment.ts).
    const environment: Record<string, string> = {};
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
        readBody: async () => ({ harness: 'general' })
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
// The mount is read from the PUBLISHED module rather than spelled out here: the
// contract has exactly one root (../src/server/api.ts `STANDALONE_MOUNT` =
// `HARNESS_API_ROOT`), and the retired `/api` mount is what an earlier edition of this
// smoke asserted. Deriving it keeps the smoke honest the next time the root moves,
// while the exact-value assert inside the check still fails a mount that drifts
// silently.
const MOUNT: string = server.STANDALONE_MOUNT;
// The listener handle is assigned inside the check and closed in `finally`, so it is
// declared with the minimal shape this smoke touches (`port`/`url`/`close`) rather than
// importing the server's own return type, which the published source does not carry
// across an untyped `import()`.
let handle: { port: number; url: string; close: () => Promise<void> } | undefined;
try {
    await check('startHarnessServer serves the standalone API on an ephemeral port', async () => {
        assert(MOUNT === '/v1/harness', `the published mount constant is not the canonical root: ${MOUNT}`);

        // The outer `handle` exists only so `finally` can always close the listener; the
        // assertions read the local binding, which TypeScript can narrow inside this closure.
        const listener = await server.startHarnessServer({
            host: '127.0.0.1',
            port: 0,
            staticRoot: null,
            databaseRoot: serverRoot
        });
        handle = listener;

        assert(listener.port > 0, 'no port was assigned');
        assert(listener.url.startsWith('http://127.0.0.1:'), 'the url is not loopback');

        const health = await fetch(`${listener.url}${MOUNT}/health`, { headers: CLIENT });
        assert(health.status === 200, `${MOUNT}/health returned ${health.status}`);

        // The retired mount has to stay retired: `/api` answering here would mean the
        // package grew a second root, which the single-mount contract forbids.
        const legacy = await fetch(`${listener.url}/api/health`, { headers: CLIENT });
        assert(legacy.status === 404, `the retired /api mount still answers: ${legacy.status}`);

        const harnesses = await fetch(`${listener.url}${MOUNT}/harnesses`, { headers: CLIENT });
        const index = await harnesses.json();
        assert(harnesses.status === 200, `${MOUNT}/harnesses returned ${harnesses.status}`);

        // The catalogue is a PAGED envelope (`items` + page meta + revision), so `items`
        // is the published shape; only `name` is read off each card.
        const names = index.items.map((entry: { name: string }) => entry.name);
        // `general` is the shipped default card (../src/server/harnesses/presets.ts). The
        // scripted `demo` and the `flaky` example presets are deleted, so the built index
        // lists ONLY production cards — asserting one of those two names here would be the
        // package check re-adding the example tier the product just removed.
        assert(names.includes('general'), 'the general preset is missing from the harness index');

        const session = await fetch(`${listener.url}${MOUNT}/sessions`, {
            method: 'POST',
            headers: { ...CLIENT, 'content-type': 'application/json' },
            body: JSON.stringify({ harness: 'general' })
        });
        const sessionBody = await session.json();
        assert(session.status === 201, `${MOUNT}/sessions returned ${session.status}`);
        assert(sessionBody.session?.harness === 'general', 'the created session is not the general harness');

        return { mount: MOUNT, url: listener.url, presets: names.length, session: session.status };
    });
} finally {
    if (handle !== undefined) {
        const url = handle.url;
        await handle.close();

        await check('listener closed', async () => {
            const state = await fetch(`${url}${MOUNT}/health`, { headers: CLIENT }).then(
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

// 4. D4: the IO worker EXECUTABLE, published as TypeScript and spawned through the
//    shipped JS bootstrap. A second published entry means a second artifact that must
//    actually RUN in a thread: importing cleanly proves nothing. This drives it exactly
//    the way ./src/server/workers/io-client.ts does — `openHarnessWorkerSession(entry)`
//    for the bootstrap + runner url + transport port, the boot marker in `workerData`,
//    then `hello`, one checkpoint, one journal append + fence — and then makes the
//    published SERVER read what the published WORKER wrote.
const IO_WORKER_ENTRY = `${EDITABLE_SOURCE_ROOT}/server/workers/io-worker.ts`;

// Mirrors ./src/server/workers/io-protocol.ts (`IO_PROTOCOL_VERSION`, `IO_WORKER_BOOT_KEY`).
// ./src/structure.test.ts pins the manifest half of the pairing, so a rename on one side fails
// a check rather than producing a server that silently persists on its own loop.
const IO_PROTOCOL_VERSION = 1;
const IO_BOOT_KEY = 'harnessIoWorker';

await check('the io-worker entry is published as its own subpath, as source', () => {
    // `exports` values are manifest-condition objects; this subpath uses the flat form,
    // so it is read as the two conditions the check asserts on.
    const entry = manifest.exports?.['./io-worker'] as { types?: string; default?: string } | undefined;

    assert(entry !== undefined, '`exports` has no "./io-worker" subpath');
    assert(entry.default === `./${IO_WORKER_ENTRY}`, `./io-worker does not resolve to ./${IO_WORKER_ENTRY}: ${JSON.stringify(entry)}`);
    // src-only: `types` answers the same `.ts` file the runtime does — there is no
    // declaration for this executable, and the runtime compiler needs the source anyway.
    assert(entry.types === `./${IO_WORKER_ENTRY}`, `./io-worker must type at the same source file: ${JSON.stringify(entry)}`);
    assert(existsSync(path.join(packageRoot, IO_WORKER_ENTRY)), `the packed shape has no ${IO_WORKER_ENTRY}`);

    return { runtime: entry.default, types: entry.types };
});

const ioRoot = path.join(work, 'io-root');
const ioDirectory = path.join(ioRoot, 'harness');
const ioState = path.join(ioDirectory, 'state.json');
const ioSession = 'io-smoke-session';

await check('the published io-worker commits, journals and fences off-thread', async () => {
    // The COPIED runner, so the shared Vite server is rooted inside the installed
    // layout rather than the repository (the same root the bootstrap resolves from).
    const workerRunner = await importPublished(`${EDITABLE_SOURCE_ROOT}/server/workers/worker-runner.ts`);
    const runner = workerRunner.openHarnessWorkerSession(path.join(packageRoot, IO_WORKER_ENTRY));

    // A `URL`, not a `file://` string: Node rejects the string form. The entry the
    // Worker is spawned with is the shipped JS bootstrap, never the `.ts` entry — raw
    // Node loads the spawn target, and the entry is fetched by the module runner.
    const worker = new Worker(pathToFileURL(runner.bootScript), {
        // The boot marker is what makes the entry self-start its message loop at all; without it
        // the thread imports, answers nothing, and exits 0.
        workerData: {
            entry: runner.entryUrl,
            port: runner.transportPort,
            [IO_BOOT_KEY]: IO_PROTOCOL_VERSION,
            maxFrameBytes: 4 * 1024 * 1024
        },
        transferList: [runner.transportPort]
    });

    try {
        // One frame in, one reply out, matched by kind AND callId: the ordering contract,
        // asserted against the published entry rather than a source file in the suite.
        // Frames are heterogeneous per `kind` (mirrors ./src/server/workers/io-protocol.ts), so the
        // envelope is modelled loosely and every field the assertions read is listed explicitly.
        const call = (frame: { kind: string; callId: number; [key: string]: unknown }): Promise<
            { kind?: string; ok?: boolean; version?: number; outcome?: string; bytes?: number; [key: string]: unknown }
        > =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    clearTimeout(timer);
                    reject(new Error(`the io-worker never answered ${frame.kind}`));
                }, 120_000);

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
        // write (../src/server/persistence.ts is the only writer of this format).
        assert(saved.kind === 'result' && saved.ok === true && saved.outcome === 'durable', `checkpoint.save: ${JSON.stringify(saved)}`);

        for (const frame of [
            { kind: 'journal.open', callId: 2, target: { root: ioDirectory, sessionId: ioSession } },
            {
                kind: 'journal.append',
                callId: 3,
                target: { root: ioDirectory, sessionId: ioSession },
                record: { turnId: 'turn-1', index: 0, at: 1_700_000_000_001, event: { type: 'text', agent: 'general', delta: 'from the published entry' } }
            },
            { kind: 'journal.flush', callId: 4, target: { root: ioDirectory, sessionId: ioSession } }
        ]) {
            const reply = await call(frame);

            assert(reply.kind === 'result' && reply.ok === true, `${frame.kind}: ${JSON.stringify(reply)}`);
        }

        const bye = await call({ kind: 'shutdown', callId: 5 });

        assert(bye.kind === 'bye' && bye.ok === true, `shutdown: ${JSON.stringify(bye)}`);

        // RELOAD, by the published server's own readers: the checkpoint parses as a database,
        // and the journal file holds the header line plus exactly the event the worker was
        // told to write. Both sides ran from the installed layout, so this is the pairing a
        // deployed host actually gets.
        const runtime = server.createHarnessRuntime({ root: ioRoot, loadEnvironment: false });

        assert(runtime.persistence !== undefined, 'the published runtime bound no persistence');

        const loaded = runtime.persistence.load();

        assert(loaded?.version === IO_PROTOCOL_VERSION, 'the worker-written document did not load');
        assert(Array.isArray(loaded.sessions) && loaded.sessions.length === 0, 'the reloaded sessions array is wrong');
        assert(runtime.persistence.lastWriteError === undefined, `lastWriteError: ${runtime.persistence.lastWriteError}`);

        const lines = readFileSync(path.join(ioDirectory, 'sessions', ioSession, 'events.jsonl'), 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line));

        assert(lines[0]?.type === 'header' && lines[0].sessionId === ioSession, `journal header: ${JSON.stringify(lines[0])}`);
        assert(lines[1]?.type === 'event' && lines[1].event?.delta === 'from the published entry', `journal event: ${JSON.stringify(lines[1])}`);

        return { bytes: saved.bytes, journalLines: lines.length };
    } finally {
        await worker.terminate();
        // Releases the parent-side port and shuts the copy's runner server down, so the
        // process can exit without holding a Vite dev server open.
        runner.dispose?.();
    }
});

if (!keep) rmSync(work, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
    fail(`${failed.length} check(s) failed: ${failed.map((result) => result.name).join(', ')}`);
}

console.log(`package runtime: ${results.length} check(s) OK`);
