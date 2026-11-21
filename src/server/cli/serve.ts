// The `--serve` options, kept out of ./index.ts for the same reason ./options.ts is.
//
// WHY THIS MODULE: `cli/index.ts` executes `main()` at import time (it IS the process),
// so a test cannot import it to see what `--serve` hands `startHarnessServer`. The
// options are a plain object built from parsed values and resolved settings, so they
// live here where a test can assert them directly, without binding a socket.
//
// R-boot — THE REGRESSION THIS FILE FIXES: the server boot no longer applies the
// package's product implicitly. An omitted `harness` is the ZERO floor (empty preset
// catalogue, no plugins, core-only toolbox) and an omitted direct-call `catalogue`
// belongs to the same explicit-boot contract. The first-party CLI is a HOST: `harness`
// and `harness --serve` have always run the shipped catalogue and the shared toolbox,
// so this launcher states that production configuration outright instead of inheriting
// a default the framework deliberately removed. `./dev.ts` states the same trio
// (`presets`, `BUILTIN_PLUGINS`, `toolbox: { sharedToolbox: true }`); this file mirrors
// it for the CLI and adds the direct-call catalogue that `--tools` and the HTTP
// `GET /tools` / `POST /tools/{name}` surface use.
//
// WHY `createToolCatalogue()` IS CALLED PER OPTIONS BUILD: the catalogue includes the
// environment-backed `search` (and `fetch`) entries, whose availability is captured at
// call time. `./index.ts` loads the package-root `.env` before `main()`, so building
// the catalogue here — inside the `--serve` branch, after that load — sees the keys an
// operator configured. A module-level snapshot would freeze the environment before the
// file is read (the same rule ./index.ts `printTools` documents).
//
// Cross-references:
//   - ./index.ts        — the `--serve` branch calls `createCliServeOptions`
//   - ./dev.ts          — the standalone launcher stating the same explicit configuration
//   - ../start.ts       — `StartServerOptions` and the zero-default boot contract
//   - ../index          — the server surface this file states its catalogue from
//                         (`presets`, `createToolCatalogue`, `BUILTIN_PLUGINS`)
//   - ../../plugin      — the generated `BUILTIN_PLUGINS` manifest (re-exported by ../index)

import { BUILTIN_PLUGINS, createToolCatalogue, presets } from '../index';
import type { HarnessBootConfiguration } from '../harnesses';
import type { RunnerSettings } from '../harnesses/types';
import type { StartServerOptions } from '../start';

// THE PRODUCTION CONFIGURATION THE FIRST-PARTY CLI SERVES, stated once.
//
// - `presets`: every shipped card is a real, live role (the fixtures are deleted), and
//   passing the executable presets keeps each card's own captured toolbox posture
//   (boot.ts `compilePreset` reuses `create` when the declaration provides one).
// - `plugins`: the generated built-in set (`async-ping`, `context-compaction`,
//   `context-trimmer`). An explicit array is authoritative: omission now means none.
// - `toolbox.sharedToolbox: true`: the historical shared toolbox for boots that create
//   cards through the registry, matching the shipped cards' own posture.
export const CLI_HARNESS_BOOT_CONFIGURATION: HarnessBootConfiguration = {
    presets,
    plugins: BUILTIN_PLUGINS,
    toolbox: { sharedToolbox: true }
};

/** The parsed `--serve` inputs this builder needs; nothing else on the CLI surface changes. */
export type CliServeOptionsInput = {
    /** `--port`; `0` asks the OS for a free port. */
    port?: number;
    /** `--host`; omitted keeps `startHarnessServer`'s loopback default. */
    host?: string;
    /** The provider triple resolved from flags/`.env` before the server starts. */
    settings: RunnerSettings;
};

/**
 * The exact options object the CLI's `--serve` branch passes to `startHarnessServer`.
 *
 * Every member reproduces the pre-R-boot production behaviour:
 *   - `settings`/`defaults` keep the existing advertised document derived from the SAME
 *     settings the sessions dial (T28), including `hasApiKey` as an advertisement only;
 *   - `catalogue` is the shipped direct-call set, now EXPLICIT because bare boot no
 *     longer supplies it;
 *   - `harness` is `CLI_HARNESS_BOOT_CONFIGURATION`, now EXPLICIT for the same reason.
 */
export const createCliServeOptions = (input: CliServeOptionsInput): StartServerOptions => ({
    port: input.port,
    host: input.host,
    settings: input.settings,
    defaults: {
        baseURL: input.settings.baseURL,
        model: input.settings.model,
        hasApiKey: input.settings.apiKey.trim().length > 0
    },
    catalogue: createToolCatalogue(),
    harness: CLI_HARNESS_BOOT_CONFIGURATION
});
