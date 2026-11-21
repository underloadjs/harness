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
// runtime per resolved root, writing the v2 shard tree under `<root>/harness/`
// (`index.json` plus `sessions/<id>/…`). It is never
// advertised as a workspace, and a different root never reuses another root's
// singleton.
//
// Cross-references:
//   - ./api.ts          — dispatcher that consumes this runtime (bootstrap rootPath)
//   - ./service.ts      — endpoint adapter calling getHarnessRuntime
//   - ./environment.ts  — the .env loader (Node entry points only)
//   - ./config.ts       — HARNESS_* defaults and the mergeSettings credential rule

import {
    EMPTY_TOOL_CATALOGUE,
    createHarnessRegistry,
    describeHarness,
    harnessBootSignature,
    resolveHarnessBootConfiguration,
    restoreHarnessRegistry
} from './harnesses';
import type { HarnessBootConfiguration, HarnessRegistry, ToolCatalogue } from './harnesses';
import type { RunnerSettings } from './harnesses/types';
import { createHarnessApi } from './api';
import type { HarnessApi } from './api';
import { loadConfiguration, resolveRuntimeConfiguration } from './config';
import type { ServerRuntimeConfiguration } from './config';
import { loadEnvironmentFile } from './environment';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';
// T15: the realtime stream. The runtime owns ONE broker per database root, so the epoch, the
// addressed revision counters, and the live subscriptions are the same objects the HTTP API and
// the WebSocket conversation report on. The stream module never imports this file, so there is no
// cycle: runtime -> stream, never stream -> runtime.
import { bridgeEventHub, createHarnessStreamMount, createStreamBridge, createStreamSources, hubStreamSources } from './stream';
import type { HarnessStreamBridge, HarnessStreamMount } from './stream';
// T13's epoch/revision hub: the one place a revision is minted, shared by the dispatcher and the
// stream so a REST header and a stream frame can never disagree.
import { createHarnessEventHub } from './api-events';
import type { HarnessEventHub } from './api-events';
// The deployment-level check that a configured worker runtime would REALLY isolate a
// thread. Importing the workers barrel here (rather than the module directly) is
// what keeps `src/server/workers` a single subsystem boundary.
import { assertWorkerRuntimeReady } from './workers';
import {
    HarnessPersistence,
    HarnessPersistenceError,
    normalizeHarnessDatabaseRoot,
    readHarnessAgentRecords
} from './persistence';
// T7: the DURABLE knowledge base. The file layer is the only thing imported here for it — the
// engine comes from the library core, and the store is a SUBSCRIBER of that engine
// (./knowledge-file-store.ts header), so this module owns one engine + at most one store per
// resolved root and nothing else in the process may build a second pair.
import { createKnowledgeEngine } from '../engine/core';
import { loadKnowledgeFileStore } from './knowledge-file-store';
import type { KnowledgeStore } from './knowledge-file-store';
import type { HarnessKnowledge, KnowledgeEngine } from '../engine/types';

// Error text helper kept local so this module has no dependency on the store.
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type HarnessRuntime = {
    store: SessionStore;
    defaults: HarnessIndex['defaults'];
    catalogue: ToolCatalogue;
    // The RESOLVED server runtime (R3): how logical threads get their CPU, after
    // `HARNESS_*` variables and explicit options are merged and validated. Reported
    // rather than inferred, so an operator can prove from the running process which
    // execution model a session will get.
    runtime: ServerRuntimeConfiguration;
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
    // -------------------------------------------------------------------
    // T7 — THE DEPLOYMENT'S KNOWLEDGE BASE (cross-session, outlives every session)
    // -------------------------------------------------------------------
    //
    // `knowledge` is the DURABLE half, and it is a live getter rather than a captured value:
    // `createHarnessRuntime` is synchronous (the SessionStore restores sessions in its own
    // constructor, so a harness can be built the instant this function returns) while
    // `loadKnowledgeFileStore` is a Promise. A captured `undefined` would tell an embedder
    // "this deployment has no knowledge" for the rest of the process on the strength of one
    // microtask. The getter answers the store as soon as it exists and `undefined` until then
    // — and until then EVERY harness still sees the same engine through `harness.knowledge`
    // (see ./runtime's knowledge block for why that is loss-free), so a reader never has to
    // guess which of two bases a session is writing.
    //
    // `undefined` FOREVER is the no-root deployment: knowledge is in memory, the process
    // performs no filesystem write for it, and nothing here pretends otherwise — the same
    // posture as `root`/`persistence` above, and the one the `knowledge` tool reports to the
    // model (a bare engine carries no `flush`).
    knowledge?: KnowledgeStore;
    // The load itself: resolves with the store, or `undefined` for a no-root runtime. A LOAD
    // FAILURE rejects here (a corrupt article file names itself in the message) and is NOT
    // replaced by an empty base — same rule as a corrupt `harness/index.json`
    // (./persistence.ts:135-137). `startHarnessServer` awaits this before it serves; a runtime
    // that was created without an awaiter keeps serving knowledge from the shared engine and
    // prints the failure once, because a broken knowledge file must not take the session store
    // down with it.
    knowledgeReady: Promise<KnowledgeStore | undefined>;
    // T15: the live update stream for THIS runtime (one broker, one epoch, one subscription set).
    // The standalone listener attaches it to its own `http.Server`; the service gateway reaches it
    // through the endpoint module's `upgrade` export, so both mounts share the same epoch. Always
    // present: a broker with no connection costs nothing (no timers, no buffers), so there is no
    // "stream disabled" state to reason about.
    stream: HarnessStreamMount;
    // The publish/counters surface the REST side calls without importing the stream module.
    streamBridge: HarnessStreamBridge;
    // T13's shared epoch/revision hub this runtime publishes through. Exposed because the epoch it
    // mints is the epoch BOTH transports must report, and an embedder may publish domain changes
    // into it directly.
    events: HarnessEventHub;
    // Detach the hub -> stream listener (a disposable runtime; production lives with the process).
    detachStreamBridge: () => void;
    // R-boot: the harness configuration this runtime was built with, as the host supplied it
    // (`undefined` for a bare runtime). Reported so an embedder can prove which templates/
    // plugins/toolbox the process is serving without reading private state.
    harnessConfiguration?: HarnessBootConfiguration;
    // R-boot: the stable identity of that configuration (`harnessBootSignature`). It is what
    // `getHarnessRuntime` compares for an already-cached root: the first caller decides the
    // runtime, so a later, DIFFERENT boot configuration is an explicit error rather than a
    // silent reuse of the first one (a warm-up must not erase what the request path asked for).
    bootSignature: string;
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
    // Override the server RUNTIME (R3): `threadExecution` and the worker bounds.
    // Merged over `HARNESS_THREAD_EXECUTION` / `HARNESS_WORKER_*`, and validated the
    // same way, so an explicit option cannot smuggle in an unbounded worker count.
    // NOTE (same singleton rule as `settings`): the first call for a root builds the
    // runtime, so a later call for that root cannot change the execution model.
    runtime?: Partial<ServerRuntimeConfiguration>;
    // Override the key-free defaults advertised to clients.
    defaults?: HarnessIndex['defaults'];
    // Inject a prebuilt catalogue/store (tests). A supplied store still owns its
    // own settings; the dispatcher only uses it for sessions and health. An
    // injected store cannot be combined with `root` (it is already constructed and
    // not bound to that database).
    //
    // The DIRECT-CALL catalogue (`GET /tools` / `POST /tools/{name}`). OMITTED IS EMPTY
    // (`EMPTY_TOOL_CATALOGUE`), the same zero-default the rest of this option object
    // follows: a bare runtime exposes no optional direct-call row (no shared presets, no
    // app tools, no web rows). The harness-owned CORE rows are still listed by the
    // dispatcher and run through a session — they are not a direct-call mechanism.
    // `createToolCatalogue()` remains available for a host that wants the production rows.
    //
    // A catalogue ALSO decides which environment-backed names a card DESCRIPTOR may list
    // (./harnesses/descriptor.ts filters `environmentTools` against `catalogue.tools`), so
    // a host that declares `environmentTools` on a preset and wants them shown must supply
    // a catalogue carrying those entries.
    catalogue?: ToolCatalogue;
    store?: SessionStore;
    // Inject a registry (tests). When omitted a fresh one is created from
    // `harness.presets` (empty by default) and shared by the store and the dispatcher; an
    // injected store must have been built with the same registry, or a created harness
    // would not resolve. On restore the saved registry metadata is replayed ONTO this
    // registry. An injected registry is authoritative, so `harness.presets` beside it
    // throws and `harness.toolbox` beside it is refused (it owns its creation defaults).
    registry?: HarnessRegistry;
    // Skip the .env load. Tests that inject every dependency use this to avoid
    // mutating process environment; production always loads.
    loadEnvironment?: boolean;
    // T15: inject the stream mount (an embedder that owns its own broker, or a test that wants a
    // fixed epoch). Omitted means "build one over THIS runtime's store and registry", which is what
    // keeps one epoch and one subscription set per process.
    stream?: HarnessStreamMount;
    // T15/T13: inject the epoch/revision hub (an embedder that already publishes domain changes).
    // Omitted means "create the process hub", which is what mints the epoch everything reports.
    events?: HarnessEventHub;
    // R-boot: THE HARNESS BOOT CONFIGURATION (./harnesses/boot.ts). Omitted is the ZERO
    // floor — an EMPTY preset catalogue, NO plugins (and no plugin rows), and no shared
    // toolbox or extra tools. That is the deliberate server seam: a host provisions its
    // templates/agents/plugins/tools explicitly, and `@underload/service` forwards the same
    // object from `variables.harness` (or the handler's own `harness` option).
    //
    // PRECEDENCE with the advanced injections above:
    //   - an injected `store` owns its registry, plugins and toolbox: `harness` may not be
    //     configured beside it (throws — there is nothing left for it to configure);
    //   - an injected `registry` is authoritative for the CATALOGUE, so a non-empty
    //     `harness.presets` beside it throws. `plugins`/`commands` still apply (per-build
    //     facts the store forwards), while a stated `harness.toolbox` beside an injected
    //     registry is REFUSED: the registry owns its creation defaults and this seam
    //     cannot change them, so accepting the posture would be a silent no-op.
    harness?: HarnessBootConfiguration;
};

export const createHarnessRuntime = (options: HarnessRuntimeOptions = {}): HarnessRuntime => {
    // Load before configuration and before the catalogue: search keys are
    // captured once, when the catalogue (or a later harness) is constructed.
    if (options.loadEnvironment !== false) loadEnvironmentFile();

    const configuration = loadConfiguration();

    // R-boot: resolve the harness configuration BEFORE anything is constructed, so a
    // malformed preset/plugin/toolbox document aborts startup with its own sentence rather
    // than letting an empty or partial catalogue serve traffic. The signature is taken from
    // the RAW value (see `harnessBootSignature`), so two calls that state the same thing
    // compare equal even though each resolution compiles fresh factories.
    if (options.store !== undefined && options.harness !== undefined) {
        throw new Error(
            'createHarnessRuntime accepts either an injected store or a `harness` boot configuration, not both: an injected store already owns its registry, plugins and toolbox.'
        );
    }

    const boot = resolveHarnessBootConfiguration(options.harness);
    const bootSignature = harnessBootSignature(options.harness);

    if (options.registry !== undefined && boot.presets.length > 0) {
        throw new Error(
            'createHarnessRuntime accepts either an injected registry or `harness.presets`, not both: two sources for the harness catalogue have no precedence order.'
        );
    }

    // B5: THE INJECTED-REGISTRY TOOLBOX CONTRACT — identical to ./start.ts. An injected
    // registry owns its creation defaults, so a stated `harness.toolbox` cannot be applied
    // here and must not be silently ignored. Checked on the RAW configuration, so an
    // injected registry WITHOUT a toolbox (every existing caller) is untouched; the boot
    // resolver's `{sharedToolbox:false}` normalization must not reject those registries.
    if (options.registry !== undefined && options.harness?.toolbox !== undefined) {
        throw new Error(
            'createHarnessRuntime cannot apply `harness.toolbox` to an injected registry: an injected registry owns its creation defaults. Pass the posture to `createHarnessRegistry(presets, { creation })` (or the `creation` defaults the registry already has) and omit `harness.toolbox`.'
        );
    }

    // R3: resolve and VALIDATE the runtime before anything is built, then assert
    // that a configured worker mode can really be honoured by this build. A worker
    // mode that was accepted but not consumed would leave the operator believing
    // their CPU-heavy tool could no longer block the server, so this fails loudly.
    const runtime = resolveRuntimeConfiguration(configuration.runtime, options.runtime);
    assertWorkerRuntimeReady(runtime);

    // Catalogue first: the describer below needs it, and it is the runtime
    // snapshot of which credential-backed tools this host can run.
    //
    // OMITTED IS EMPTY (zero-default). Falling back to `createToolCatalogue()` exposed the
    // package's shared preset/app/web rows over `/tools` on a bare runtime, contradicting
    // "no additional tools beyond core". A host states the production catalogue explicitly
    // (`createToolCatalogue()`); an empty catalogue still lets the dispatcher list the
    // harness-owned CORE rows, which are session-bound rather than direct-call.
    const catalogue = options.catalogue ?? EMPTY_TOOL_CATALOGUE;

    // R3b: one durable database per resolved root. Read BEFORE sessions exist so
    // the registry is rebuilt first; a session's harness is then rebuilt from its
    // own frozen preset record, which is independent of later registry patches.
    const root = normalizeHarnessDatabaseRoot(options.root);

    // T7: the knowledge base is resolved at the SAME moment as the agent overlay below —
    // the same "durable thing at the root, exactly one per resolved root" discipline as
    // `readHarnessAgentRecords(root)` — and it is kicked off here rather than at the first
    // tool call, because the whole point of the base is that it is ready before any session
    // exists. `prepareHarnessKnowledge` is memoized per root, so this line is also what
    // `startHarnessServer` and the service handler await without ever loading twice.
    //
    // WHY THE PROMISE IS NOT AWAITED HERE: `createHarnessRuntime` is sync (the SessionStore
    // restores every saved session inside its constructor, so the first harness exists the
    // instant this function returns), while the file load is async. The ENGINE is therefore
    // created synchronously and the store ADOPTS it (`loadKnowledgeFileStore({ engine })`,
    // ./knowledge-file-store.ts:411-425 — the files win per article, an article the engine
    // holds with no file is KEPT and committed, and the watermark never moves backwards), so
    // a write that lands in the load window is durable a moment later instead of being lost
    // or stranded on a second engine. A host that wants the durable half BEFORE its first
    // build awaits `prepareHarnessKnowledge` itself — which is exactly what ./start.ts and
    // ./service.ts do.
    const knowledgeReady = prepareHarnessKnowledge(root);

    // A knowledge load failure is printed once, and the base stays in memory on the shared
    // engine. Deliberately not fatal to a runtime: a corrupt `harness/index.json` aborts
    // startup because the SESSION document is what the store cannot serve without
    // (./persistence.ts:135-137), while a corrupt article file costs one base the sessions
    // still do not need to answer a prompt. The rejection still reaches an awaiter through
    // `knowledgeReady` below (./start.ts fails startup with the real message).
    void knowledgeReady.catch((error: unknown) => {
        console.error(`[harness] the knowledge base could not be loaded and stays in memory: ${messageOf(error)}`);
    });

    // T19: the global agent overlay is durable registry state (`<root>/harness/agents.json`),
    // so it is read at the same moment as the checkpoint header `index.json` and replayed onto
    // the registry BEFORE
    // its first `agents()` read. An injected registry gets the same replay below, after the
    // database load, so a host that owns its registry is not second-class.
    const agentRecords = readHarnessAgentRecords(root);

    // R-boot: an injected registry is authoritative; otherwise the catalogue is EXACTLY
    // what the boot configuration declared (empty when it declared nothing), and the
    // registry's creation defaults carry the same toolbox posture so an HTTP-created card
    // and a restored row cannot regain the shared set the deployment did not ask for.
    const registry =
        options.registry ??
        createHarnessRegistry(boot.presets, { agentRecords, creation: boot.toolbox });

    if (options.store !== undefined && root !== undefined) {
        throw new Error(
            'createHarnessRuntime accepts either an injected store or a database root, not both: an injected store is not bound to that database.'
        );
    }

    const persistence = root === undefined ? undefined : new HarnessPersistence(root);
    const database = persistence?.load();

    // T19: a host-injected registry was built without this root's overlay, so replay it
    // here. A registry this function created already carries it, and replaying twice would
    // be a no-op anyway (`restoreAgentRecords` is total).
    if (options.registry !== undefined && agentRecords.length > 0) {
        registry.restoreAgentRecords(agentRecords);
    }

    if (database !== undefined && persistence !== undefined) {
        try {
            // T5: `database.deleted` carries the built-ins the operator removed, so
            // this build's shipped copies of them are taken out before the saved
            // rows are replayed. Absent for a pre-T5 document (no deletions).
            restoreHarnessRegistry(registry, database.registry, database.deleted ?? []);
        } catch (error) {
            throw new HarnessPersistenceError(
                persistence.file,
                `The saved harness registry could not be restored: ${messageOf(error)}`
            );
        }
    }

    // The store owns no catalogue, so bind its describer to this runtime's. A
    // supplied store keeps its own registry/settings (tests) and is used as-is.
    //
    // T5 (R2/R3): the runtime's PLUGIN SETTINGS STORE lives inside this SessionStore (built in
    // its constructor from `database.pluginSettings` + the generated built-in manifest), so
    // there is exactly one per resolved database root - the same singleton rule as `store`,
    // `registry`, and `events`. No extra wiring belongs here: `buildHarness` hands that one
    // store's LIVE provider to every harness it builds (fresh and restored), and
    // `runtime.store.pluginSettings` is the handle the REST surface writes through. An injected
    // store keeps its own, exactly like its own settings and registry.
    //
    // ONE provider-settings object per runtime (T28): the store builds harnesses with it, and
    // the dispatcher authenticates its OWN provider calls (`POST /models`) with the SAME
    // credential through a private channel. A service deployment therefore cannot report one
    // provider on `/config` and dial another — or an unauthenticated one — on discovery.
    const serverSettings = options.settings ?? configuration.settings;

    const store =
        options.store ??
        new SessionStore(
            serverSettings,
            registry,
            (preset) => describeHarness(preset, catalogue),
            {
                ...(persistence === undefined ? {} : { persistence }),
                ...(database === undefined ? {} : { database }),
                // R1/R3: the store gets the RESOLVED runtime, so the execution model it
                // enforces is the one this process reported - never a second guess.
                runtime,
                // T7: THE KNOWLEDGE ACCESSOR, on the same one-per-root rule as `pluginSettings`
                // and the tool switch above. It is a FUNCTION, not the value, for one reason:
                // the store builds harnesses inside its own constructor (a restored session,
                // ./sessions.ts) as well as on a later request, and the durable store may land
                // between those two moments. Each build reads the live value, so the first
                // restored session and the last one created share one object, and the window
                // where the answer is the shared engine costs nothing (that engine is what the
                // store adopts on load). An injected store keeps its own knowledge, exactly like
                // its own settings and registry — there is nothing to wire here.
                knowledge: () => harnessKnowledgeOf(root),
                // R-boot: the per-BUILD half of the boot configuration. Explicit arrays
                // (including `[]`) are what make omission mean "none"; the store forwards
                // them to every preset factory through `HarnessPresetReport`. The descriptor
                // list is derived from the executable plugins by the boot resolver, so the
                // `/plugins` rows and the loaded set are one catalogue.
                plugins: boot.plugins,
                pluginDescriptors: boot.pluginDescriptors,
                ...(boot.commands.length === 0 ? {} : { harnessCommands: boot.commands })
            }
        );

    // T28: same rule as ./start.ts — an advertised document derived from the settings this
    // process actually holds can never disagree with what sessions dial.
    const defaults =
        options.defaults ??
        (options.settings === undefined
            ? configuration.defaults
            : {
                  baseURL: serverSettings.baseURL,
                  model: serverSettings.model,
                  hasApiKey: serverSettings.apiKey.trim().length > 0
              });

    // T15/T13 integration: ONE epoch/revision hub per runtime. The dispatcher stamps the hub's
    // counters on every REST read, and the stream reads the SAME counters for
    // `subscription_state.revisions` and answers `welcome` with the SAME epoch — the only way the
    // contract's "compare a revision within one epoch" rule can hold across HTTP and WS.
    // `createStreamSources` stays underneath, so existence still answers from the store even before
    // the hub grows that surface, and `hubStreamSources` supplies the counters and the resync links.
    const events = options.events ?? createHarnessEventHub();

    const stream =
        options.stream ??
        createHarnessStreamMount({ sources: hubStreamSources(events, createStreamSources({ store, registry })) });

    // Every REST write the hub publishes becomes exactly one stream fan-out. The hub has already
    // moved the counters, so the bridge mirrors them instead of bumping (see ./stream/mount.ts).
    const detachStreamBridge = bridgeEventHub(events, stream.broker);

    const api = createHarnessApi({
        store,
        defaults,
        // T28: the private credential channel. A host that supplies its own STORE (tests, or a
        // embedding service) still hands the dispatcher the settings it wants OUTBOUND reads to
        // use; the store keeps its own copy for sessions, and the credential-scope rule in
        // ./config.ts is what stops either one from sending a key to the wrong provider.
        settings: serverSettings,
        // T28: the resolved runtime block, so `/config` reports the execution model this
        // runtime's store actually enforces (rather than a second environment parse).
        runtime,
        registry,
        catalogue,
        events,
        // T19: the durable target of the global agent overlay (`PATCH/DELETE /agents/{id}`).
        // One value decides BOTH whether an agent edit is durable and what the receipt says
        // about a restart, so the answer can never claim more than the deployment stores.
        ...(root === undefined ? {} : { databaseRoot: root })
    });

    return {
        store,
        defaults,
        catalogue,
        runtime,
        registry,
        api,
        stream,
        streamBridge: createStreamBridge(stream.broker),
        events,
        detachStreamBridge,
        // R-boot: what this runtime was configured with, and its stable identity for the
        // per-root cache guard below.
        ...(options.harness === undefined ? {} : { harnessConfiguration: options.harness }),
        bootSignature,
        // T7: live reads of the knowledge seam (see the `HarnessRuntime` members above). The
        // getter is what keeps `runtime.knowledge` true from the moment the load settles,
        // instead of freezing the answer this synchronous function happened to have.
        get knowledge(): KnowledgeStore | undefined {
            return peekHarnessKnowledge(root);
        },
        knowledgeReady,
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

    if (existing !== undefined) {
        // R-boot: THE CACHE GUARD. The first caller for a root decides the templates,
        // plugins and toolbox, and the runtime cannot be rebuilt without a second writer on
        // the database. A later caller that states a DIFFERENT configuration must therefore
        // fail loudly: silently returning the first runtime is exactly how an unconfigured
        // warm-up would erase what the request path (or a host) configured.
        //
        // The comparison is the SIGNATURE of the raw configuration, not object identity:
        // the service entry hands the same `variables.harness` object to the warm-up and to
        // every route, but a test (or a host composing twice) may hand a structurally equal
        // fresh object and must not be treated as a conflict.
        const signature = harnessBootSignature(options.harness);

        if ((existing.bootSignature ?? harnessBootSignature(undefined)) !== signature) {
            throw new Error(
                `The harness runtime for "${key === '' ? '<in-memory>' : key}" was already created with a DIFFERENT boot configuration. ` +
                    'The first caller decides the runtime for a database root, so configure the harness before the warm-up/first request (pass the SAME `harness`/`variables.harness` value to both) instead of relying on a later call to reconfigure it.'
            );
        }

        return existing;
    }

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

// ---------------------------------------------------------------------------
// T7 — THE KNOWLEDGE BASE, ONE PER RESOLVED DATABASE ROOT
// ---------------------------------------------------------------------------
//
// WHY IT LIVES HERE AND NOT ON THE SESSION STORE. Knowledge is deployment state: the file
// layer keeps it at `<databaseRoot>/harness/knowledge/` (./knowledge-file-store.ts), which is
// a SIBLING of `harness/sessions/` and therefore outside every session folder — killing or
// deleting a session changes nothing about it, which is the guarantee the user asked for and
// which ./knowledge-session.test.ts pins. `SessionStore` is the wrong owner for it for the
// same reason `HarnessPersistence` is not: the store's life is the database's life, and its
// sessions come and go inside it. This module already owns the one thing the knowledge base is
// keyed by (the resolved root, `runtimes` above), so it owns the base too.
//
// ONE ENTRY PER ROOT, WITH ONE ENGINE AND AT MOST ONE STORE.
//   - `engine` is created SYNCHRONOUSLY on first touch, so a harness built before the store
//     load settles still holds THE engine (see the note in `createHarnessRuntime`);
//   - `store` is the durable half once `loadKnowledgeFileStore` settles;
//   - `loading` is the memoized promise, so ten concurrent hosts cause exactly one load.
// The '' key is the no-root deployment, matching `runtimes`: knowledge works in memory and
// the process performs NO filesystem write for it.
type KnowledgeEntry = {
    engine?: KnowledgeEngine;
    store?: KnowledgeStore;
    loading?: Promise<KnowledgeStore | undefined>;
};

const knowledgeEntries = new Map<string, KnowledgeEntry>();

const knowledgeEntryOf = (root: string | null | undefined): KnowledgeEntry => {
    const key = runtimeKey(root);
    const existing = knowledgeEntries.get(key);

    if (existing !== undefined) return existing;

    // The engine exists the moment anything asks about knowledge for this root, whether or not
    // a durable store can ever follow. `ids`/`now` are left alone: the engine's own defaults
    // are what every other consumer of the base (the tool, a wrapper tool) sees too.
    const created: KnowledgeEntry = { engine: createKnowledgeEngine() };

    knowledgeEntries.set(key, created);

    return created;
};

// The engine every harness of this root shares — durable or not. Exported because an embedder
// that wants the base without a runtime (a CLI subcommand, a test) still must not build a
// second engine over one directory: two engines mean two article sets that both believe
// themselves authoritative.
export const getHarnessKnowledgeEngine = (root?: string | null): KnowledgeEngine => {
    const entry = knowledgeEntryOf(root);

    if (entry.engine === undefined) entry.engine = createKnowledgeEngine();

    return entry.engine;
};

// Load (or join the load of) the durable half. Idempotent per root, and the SAME promise
// object for concurrent callers, so `startHarnessServer`, the service handler, and
// `createHarnessRuntime` cannot race each other into two stores over one directory.
//
// A FAILURE is memoized exactly like a corrupt session document is
// (./runtimes above: "a corrupt database throws on creation and is NOT replaced by an empty
// one: every later request for that root fails clearly until the file is fixed"): the rejected
// promise is the answer for the rest of the process, so a broken knowledge file is a fact an
// operator fixes, not a condition this function re-probes on every request (a sync directory
// scan per request would be a second problem it created).
//
// A no-root deployment resolves `undefined` and never touches `node:fs`.
export const prepareHarnessKnowledge = (root?: string | null): Promise<KnowledgeStore | undefined> => {
    const entry = knowledgeEntryOf(root);

    if (entry.store !== undefined) return Promise.resolve(entry.store);

    const key = runtimeKey(root);

    // No database root means no durable knowledge, and that is a statement about THIS
    // deployment rather than a fallback: `loadKnowledgeFileStore` refuses a blank root on
    // purpose (./knowledge-file-store.ts:1010-1013), so the in-memory case is decided HERE,
    // once, in code — the same "absent means absent" posture as `agents.json` with no root
    // (./persistence.ts:3285).
    if (key === '') return Promise.resolve(undefined);

    if (entry.loading !== undefined) return entry.loading;

    const loading = loadKnowledgeFileStore({ root: key, engine: getHarnessKnowledgeEngine(root) }).then(
        (store) => {
            entry.store = store;

            return store;
        }
    );

    entry.loading = loading;

    return loading;
};

// The settled durable half, or `undefined` (no root, or a load that has not landed / failed).
// Synchronous by design: this is what a HARNESS BUILD reads (./sessions.ts `buildHarness`), and
// harness construction cannot await.
export const peekHarnessKnowledge = (root?: string | null): KnowledgeStore | undefined =>
    knowledgeEntryOf(root).store;

// WHAT A HARNESS IS BUILT WITH (`HarnessConfiguration.knowledge`, ../types:4772): the store as
// soon as it exists, and until then THE shared engine — the same object, for every build of
// this root, because `loadKnowledgeFileStore` adopts it (./knowledge-file-store.ts:1042-1072).
// Handing over an engine is never a lie about durability: an engine-shaped member carries no
// `flush`, so the `knowledge` tool says "in memory" rather than promising bytes
// (../types `HarnessKnowledge`).
export const harnessKnowledgeOf = (root?: string | null): HarnessKnowledge =>
    peekHarnessKnowledge(root) ?? getHarnessKnowledgeEngine(root);

// The durability barrier for a root: awaits the load if one is still running, then the store's
// own `flush()`. A no-root runtime costs nothing. Used by a host that must answer "this
// article survived" before it responds.
export const flushHarnessKnowledge = async (root?: string | null): Promise<void> => {
    const store = await prepareHarnessKnowledge(root);

    if (store === undefined) return;

    await store.flush();
};

// THE ONE DISPOSAL PATH. `KnowledgeStore.dispose()` flushes, clears the trailing timer, and
// unsubscribes from the engine, and it must happen exactly ONCE per store — which is why it is
// a server call (./start.ts `close()`) and never a `harness.dispose` hook: one session's
// teardown would otherwise unsubscribe the base every other session in the process is still
// writing (../harness.ts keeps the matching note). The entry is evicted afterwards so a
// listener restarted in the same process (a test, an embedder) loads a FRESH store instead of
// disposing one twice, and the engine it held goes with it.
export const disposeHarnessKnowledge = async (root?: string | null): Promise<void> => {
    const key = runtimeKey(root);

    if (key === '') return;

    const entry = knowledgeEntries.get(key);
    const store = entry?.store;

    // Nothing durable for this root: an in-memory engine has no timer and no subscription to
    // release, and the entry is deliberately KEPT (its articles stay readable for the rest of
    // the process, which is what an in-memory deployment promises).
    if (entry === undefined || store === undefined) return;

    knowledgeEntries.delete(key);

    await store.flush();
    await store.dispose();
};
