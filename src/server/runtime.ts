// Lazy shared runtime for the service-hosted harness API.
//
// The @underload/service loader imports every `service-route*.ts` module BEFORE
// any request arrives. That import must not read `.env`, build a provider
// catalogue, or construct sessions: route modules only describe a URL and a
// handler. The first request therefore calls `getHarnessRuntime()`, which loads
// the package-root `.env` and builds the store/catalogue exactly once.
//
// Standalone `src/server/start.ts` keeps its own explicit construction; this module
// exists so the service endpoints share ONE store per database root across every
// canonical route module and every request.
//
// ROOT CONTRACT: the bootstrap document's `rootPath` is the canonical API URL
// ('/v1/harness', the mount), not a filesystem path. There is deliberately no
// workspace-root option here: the file/command tools resolve relative paths
// against the server process's working directory (process.cwd()) and have no
// sandbox or fence, so advertising a root would claim behaviour the tools do not
// implement. `variables.root` passed by the service loader is the DATABASE_ROOT
// storage boundary (R3b): ./service.ts resolves it and this module keeps one
// runtime per resolved root, writing `<root>/harness/state.json`. It is never
// advertised as a workspace, and a different root never reuses another root's
// singleton.
//
// Cross-references:
//   - ./api.ts          — dispatcher that consumes this runtime (bootstrap rootPath)
//   - ./service.ts      — endpoint adapter calling getHarnessRuntime
//   - ./environment.ts  — the .env loader (Node entry points only)
//   - ./config.ts       — HARNESS_* defaults and the mergeSettings credential rule

import { createHarnessRegistry, createToolCatalogue, describeHarness, restoreHarnessRegistry } from './harnesses';
import type { HarnessRegistry, ToolCatalogue } from './harnesses';
import type { RunnerSettings } from './harnesses/types';
import { createHarnessApi } from './api';
import type { HarnessApi } from './api';
import { loadConfiguration } from './config';
import { loadEnvironmentFile } from './environment';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';
import {
    HarnessPersistence,
    HarnessPersistenceError,
    normalizeHarnessDatabaseRoot
} from './persistence';

// Error text helper kept local so this module has no dependency on the store.
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type HarnessRuntime = {
    store: SessionStore;
    defaults: HarnessIndex['defaults'];
    catalogue: ToolCatalogue;
    // The shared in-memory harness registry, so a canonical route module and the
    // standalone adapter resolve sessions and accept create/patch identically.
    registry: HarnessRegistry;
    // Dispatcher bound to the mount the service exposes.
    api: HarnessApi;
    // Resolved database root (absolute) when this runtime persists; undefined for
    // the in-memory runtime. Two different roots NEVER share a runtime (see
    // getHarnessRuntime), so a supplied root can never be silently ignored.
    root?: string;
    persistence?: HarnessPersistence;
};

export type HarnessRuntimeOptions = {
    // Durable database root (R3b). The service passes its `variables.root`
    // (DATABASE_ROOT) here; the standalone server has `databaseRoot`. When omitted
    // the runtime is the previous in-memory store (direct unit tests). A supplied
    // root is resolved to an absolute path and NEVER ignored: invalid values throw.
    root?: string | null;
    // Override the provider settings. When omitted, `loadConfiguration()` reads
    // the process environment AFTER the .env load below.
    settings?: RunnerSettings;
    // Override the key-free defaults advertised to clients.
    defaults?: HarnessIndex['defaults'];
    // Inject a prebuilt catalogue/store (tests). A supplied store still owns its
    // own settings; the dispatcher only uses it for sessions and health. An
    // injected store cannot be combined with `root` (it is already constructed and
    // not bound to that database).
    catalogue?: ToolCatalogue;
    store?: SessionStore;
    // Inject a registry (tests). When omitted a fresh one is created and shared by
    // the store and the dispatcher; an injected store must have been built with
    // the same registry, or a created harness would not resolve. On restore the
    // saved registry metadata is replayed ONTO this registry.
    registry?: HarnessRegistry;
    // Skip the .env load. Tests that inject every dependency use this to avoid
    // mutating process environment; production always loads.
    loadEnvironment?: boolean;
};

export const createHarnessRuntime = (options: HarnessRuntimeOptions = {}): HarnessRuntime => {
    // Load before configuration and before the catalogue: search keys are
    // captured once, when the catalogue (or a later harness) is constructed.
    if (options.loadEnvironment !== false) loadEnvironmentFile();

    const configuration = loadConfiguration();

    // Catalogue first: the describer below needs it, and it is the runtime
    // snapshot of which credential-backed tools this host can run.
    const catalogue = options.catalogue ?? createToolCatalogue();
    const registry = options.registry ?? createHarnessRegistry();

    // R3b: one durable database per resolved root. Read BEFORE sessions exist so
    // the registry is rebuilt first; a session's harness is then rebuilt from its
    // own frozen preset record, which is independent of later registry patches.
    const root = normalizeHarnessDatabaseRoot(options.root);

    if (options.store !== undefined && root !== undefined) {
        throw new Error(
            'createHarnessRuntime accepts either an injected store or a database root, not both: an injected store is not bound to that database.'
        );
    }

    const persistence = root === undefined ? undefined : new HarnessPersistence(root);
    const database = persistence?.load();

    if (database !== undefined && persistence !== undefined) {
        try {
            restoreHarnessRegistry(registry, database.registry);
        } catch (error) {
            throw new HarnessPersistenceError(
                persistence.file,
                `The saved harness registry could not be restored: ${messageOf(error)}`
            );
        }
    }

    // The store owns no catalogue, so bind its describer to this runtime's. A
    // supplied store keeps its own registry/settings (tests) and is used as-is.
    const store =
        options.store ??
        new SessionStore(
            options.settings ?? configuration.settings,
            registry,
            (preset) => describeHarness(preset, catalogue),
            {
                ...(persistence === undefined ? {} : { persistence }),
                ...(database === undefined ? {} : { database })
            }
        );

    const defaults = options.defaults ?? configuration.defaults;

    const api = createHarnessApi({ store, defaults, registry, catalogue });

    return {
        store,
        defaults,
        catalogue,
        registry,
        api,
        ...(root === undefined ? {} : { root }),
        ...(persistence === undefined ? {} : { persistence })
    };
};

// One module-level runtime per resolved database root, so every discovered service
// route shares the store for the SAME root while two different roots stay fully
// isolated (each with its own registry/sessions/database). The '' key is the
// in-memory runtime used when the host supplies no root.
const runtimes = new Map<string, HarnessRuntime>();

const runtimeKey = (root: string | null | undefined): string =>
    normalizeHarnessDatabaseRoot(root) ?? '';

// Resolve (or lazily create) the runtime for a root. A corrupt database throws on
// creation and is NOT replaced by an empty one: every later request for that root
// fails clearly until the file is fixed.
export const getHarnessRuntime = (options: HarnessRuntimeOptions = {}): HarnessRuntime => {
    const key = runtimeKey(options.root);
    const existing = runtimes.get(key);

    if (existing !== undefined) return existing;

    const created = createHarnessRuntime(options);
    runtimes.set(key, created);
    return created;
};

// Exported for adapters/tests that inject their own runtime; production never
// resets the shared ones. `root` selects the entry; omit it for the in-memory one.
export const setHarnessRuntime = (next: HarnessRuntime | undefined, root?: string | null): void => {
    const key = runtimeKey(root);

    if (next === undefined) {
        runtimes.delete(key);
        return;
    }

    runtimes.set(key, next);
};
