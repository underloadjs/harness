// Lazy shared runtime for the service-hosted harness API.
//
// The @underload/service loader imports every `service-route*.ts` module BEFORE
// any request arrives. That import must not read `.env`, build a provider
// catalogue, or construct sessions: route modules only describe a URL and a
// handler. The first request therefore calls `getHarnessRuntime()`, which loads
// the package-root `.env` and builds the store/catalogue exactly once.
//
// Standalone `server/index.ts` keeps its own explicit construction; this module
// exists so the service endpoints share ONE store across every canonical route
// module and every request.
//
// ROOT CONTRACT: the bootstrap document's `rootPath` is the canonical API URL
// ('/v1/harness', the mount), not a filesystem path. There is deliberately no
// workspace-root option here: the file/command tools resolve relative paths
// against the server process's working directory (process.cwd()) and have no
// sandbox or fence, so advertising a root would claim behaviour the tools do not
// implement. `variables.root` passed by the service loader is the shared storage
// boundary for database endpoints and is unrelated; it must not be used here.
//
// Cross-references:
//   - ./api.ts          — dispatcher that consumes this runtime (bootstrap rootPath)
//   - ./service.ts      — endpoint adapter calling getHarnessRuntime
//   - ./environment.ts  — the .env loader (Node entry points only)
//   - ./config.ts       — HARNESS_* defaults and the mergeSettings credential rule

import { createToolCatalogue } from '../harnesses';
import type { ToolCatalogue } from '../harnesses';
import type { RunnerSettings } from '../harnesses/types';
import { createHarnessApi } from './api';
import type { HarnessApi } from './api';
import { loadConfiguration } from './config';
import { loadEnvironmentFile } from './environment';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';

export type HarnessRuntime = {
    store: SessionStore;
    defaults: HarnessIndex['defaults'];
    catalogue: ToolCatalogue;
    // Dispatcher bound to the mount the service exposes.
    api: HarnessApi;
};

export type HarnessRuntimeOptions = {
    // Override the provider settings. When omitted, `loadConfiguration()` reads
    // the process environment AFTER the .env load below.
    settings?: RunnerSettings;
    // Override the key-free defaults advertised to clients.
    defaults?: HarnessIndex['defaults'];
    // Inject a prebuilt catalogue/store (tests). A supplied store still owns its
    // own settings; the dispatcher only uses it for sessions and health.
    catalogue?: ToolCatalogue;
    store?: SessionStore;
    // Skip the .env load. Tests that inject every dependency use this to avoid
    // mutating process environment; production always loads.
    loadEnvironment?: boolean;
};

export const createHarnessRuntime = (options: HarnessRuntimeOptions = {}): HarnessRuntime => {
    // Load before configuration and before the catalogue: search keys are
    // captured once, when the catalogue (or a later harness) is constructed.
    if (options.loadEnvironment !== false) loadEnvironmentFile();

    const configuration = loadConfiguration();
    const store = options.store ?? new SessionStore(options.settings ?? configuration.settings);
    const catalogue = options.catalogue ?? createToolCatalogue();
    const defaults = options.defaults ?? configuration.defaults;

    const api = createHarnessApi({ store, defaults, catalogue });

    return { store, defaults, catalogue, api };
};

// Module-level singleton: every discovered service route shares one store, so a
// session created through one route module is visible through every other.
let runtime: HarnessRuntime | undefined;

export const getHarnessRuntime = (): HarnessRuntime => {
    runtime ??= createHarnessRuntime();
    return runtime;
};

// Exported for adapters/tests that inject their own runtime; production never
// resets the shared one.
export const setHarnessRuntime = (next: HarnessRuntime | undefined): void => {
    runtime = next;
};
