// The server surface of @underload/harness.
//
// Public as `@underload/harness/server` (Node-only) and re-exported from the
// Node root `@underload/harness`. It is the complete reusable server API:
//
//   - `startHarnessServer`  — EXPLICIT standalone listener (`./start`). Importing
//     this module never binds a port; only calling the function does.
//   - `createHarnessRuntime` / `getHarnessRuntime` — the lazy store+catalogue the
//     @underload/service routes share; the service gateway owns the listener.
//   - `createHarnessServiceHandler` — endpoint adapter, Origin gate, raw SSE.
//   - `createHarnessSseResponse` / `runHarnessSseStream` — the package's ONE SSE writer
//     (frame contract, preamble, `X-Accel-Buffering`, backpressure, cancel->abort) and the
//     Node `ServerResponse` bridge over it, so a host streaming harness events from its own
//     endpoint imports them instead of writing a third copy (issue 0006).
//   - `createHarnessApi` / `createHarnessHandler` — transport-neutral dispatcher
//     and the Node `http` adapter.
//   - `SessionStore` — authoritative turns + FIFO task queue.
//   - `HarnessPersistence` — the versioned atomic database under `<root>/harness/`
//     (R3b), plus registry/session record helpers used to rebuild a restart.
//   - `protocol` types — the wire contract the browser client consumes.
//   - `harnesses` — presets, registry, catalogue, descriptors, scripted demo.
//
// Why `./api` and `./harnesses` are listed name-by-name instead of `export *`:
// `./protocol` already re-exports `RunnerSettings` (from `./harnesses/types`) and
// the frontend client mirrors `HarnessBootstrap`. Star-exporting all three would
// make those names ambiguous at the package root, which re-exports this barrel.
// The explicit lists keep exactly one declaration per name.
//
// Cross-references:
//   - ./start.ts      — startHarnessServer (standalone, optional)
//   - ./runtime.ts    — service-owned lazy singleton
//   - ./endpoint/harness/service-route*.ts — discovered by @underload/service
//   - ../frontend/index.ts — the browser client barrel
//   - ../../package.json  — "exports" maps this barrel to dist/server/index.d.ts
export * from './start';
export * from './protocol';
export * from './config';
export * from './environment';
export * from './package-root';
export * from './handler';
export * from './runtime';
export * from './service';
export * from './sessions';
export * from './persistence';
export * from './static';

// Dispatcher/constants from ./api. `HarnessBootstrap` is intentionally omitted:
// the browser client owns the client-facing copy (it keeps `agents` optional so
// an older server still boots), so exporting both would collide at the root.
export {
    MAX_API_BODY_BYTES,
    SERVICE_MOUNT,
    STANDALONE_MOUNT,
    HttpError,
    createHarnessApi
} from './api';
export type {
    HarnessApi,
    HarnessApiEmit,
    HarnessApiOptions,
    HarnessApiRequest,
    HarnessApiResult,
    HarnessApiStream
} from './api';

// T15: the realtime transport surface, exported name-by-name (the same reason `./api` is listed
// above: `export *` from two barrels would make names ambiguous at the package root, and a
// declaration file that cannot resolve a name is a published breakage).
export {
    HARNESS_WS_CLOSE_CODES,
    HARNESS_WS_STREAM_PATH,
    HARNESS_WS_SCOPE_BASELINES,
    HARNESS_WS_SCOPE_FILTERS,
    HARNESS_WS_SCOPE_IDS,
    HARNESS_WS_SCOPE_PUBLISHES,
    HARNESS_WS_KIND_RESOURCES,
    HARNESS_WS_TUNABLE_BOUNDS,
    WEBSOCKET_STATE,
    chunkStreamPayload,
    createStreamBroker,
    createStreamBridge,
    createStreamSources,
    bridgeEventHub,
    decodeStreamCursor,
    defaultStreamLink,
    encodeStreamCursor,
    hubResourceId,
    hubStreamSources,
    HARNESS_STREAM_EPOCH,
    performUpgrade,
    rejectUpgrade,
    parseClientFrame,
    publishStreamEvent,
    resolveStreamLimits,
    startStreamConnection,
    streamScopePublishes
} from './stream';
export type {
    ClientFrameResult,
    HarnessSocket,
    HarnessSocketSendMeta,
    HarnessSocketSendResult,
    HarnessStreamBridge,
    HarnessStreamBroker,
    HarnessStreamMount,
    HarnessStreamMountOptions,
    HarnessUpgradeOptions,
    StreamBrokerSources,
    StreamConnection,
    StreamConnectionOptions,
    StreamCursor,
    StreamDelivery,
    StreamEvent,
    StreamEventFor,
    StreamFailure,
    StreamOriginPolicy,
    StreamRegistryLookups,
    StreamResourceRef,
    StreamScopeIds,
    StreamSessionHandle,
    StreamSink,
    StreamStoreLookups,
    StreamSubscribeFrame,
    StreamSubscribeOutcome,
    StreamSubscribeRequest
} from './stream';
// T27: this barrel used to re-export `StreamUpgradeHandler` from './stream'. No such
// declaration exists anywhere in the transport (./stream/{protocol,broker,transport,
// connection,mount}.ts, all re-exported by ./stream/index.ts), so the name was a stale
// entry that made the whole barrel fail TS2305. The upgrade hook the gateway actually
// consumes is `ServiceUpgradeHandler` (./service.ts:419), which `export * from './service'`
// (line 38 above) already publishes; the per-mount upgrade method is a member of
// `HarnessStreamMount.upgrade` (./stream/mount.ts:108), also already exported. Nothing
// referenced `StreamUpgradeHandler`, so dropping the phantom name removes no capability.

// The catalogue the CLI and the server share (see ./harnesses/index.ts).
export {
    AGENT_PROFILES,
    AGENT_PROFILE_NAMES,
    // The production catalogue is `presets`, and it is the whole catalogue: the
    // offline/failure fixture presets are deleted, so there is no lookup superset and
    // no opt-in list left to export.
    CORE_ENVIRONMENT_TOOL_NAMES,
    CORE_PRESET_TOOL_NAMES,
    CORE_TOOL_GROUP,
    CORE_TOOL_NAMES,
    CORE_TOOL_SESSION_HINT,
    PRESET_ALIASES,
    PRESET_MAX_ITERATIONS,
    SHARED_APP_TOOL_NAMES,
    SHARED_TOOLS,
    SHARED_TOOL_NAMES,
    WEBSEARCH_ENVIRONMENT,
    WEBSEARCH_UNCONFIGURED_HINT,
    HarnessRegistryError,
    agentFromProfile,
    agentInstruction,
    agentProfile,
    agentProfiles,
    agentsFromProfiles,
    coreToolNames,
    createCoreToolEntries,
    createHarnessRegistry,
    createProfiledHarness,
    createToolboxHarness,
    createToolCatalogue,
    createWebSearchCatalogueEntry,
    // R9-R11: the fetch half of the environment-backed core pair.
    createWebFetchCatalogueEntry,
    describeAgent,
    describeAgents,
    describeHarness,
    findPreset,
    harnessTools,
    isAgentProfileName,
    isLegacyShippedDefinition,
    presets,
    presetFromRecord,
    presetRecordEquals,
    presetToRecord,
    providerOf,
    restoreHarnessRegistry,
    SPECIALIST_AGENT_NAMES,
    teamOf
} from './harnesses';
export type {
    AgentProfile,
    CatalogueEntry,
    DescriptorCatalogue,
    HarnessPatch,
    HarnessPreset,
    HarnessRegistration,
    HarnessRegistry,
    HarnessRegistryOptions,
    HarnessRegistrySnapshot,
    LegacyPresetDefinition,
    RunnerSettings,
    ToolAvailability,
    ToolCatalogue,
    ToolCatalogueOptions,
    ToolGroup,
    ToolboxHarnessConfiguration,
    WebSearchCatalogueEntry,
    WebSearchCatalogueOptions,
    WebFetchCatalogueEntry,
    WebFetchCatalogueOptions
} from './harnesses';
