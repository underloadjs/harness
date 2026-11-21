// THE HARNESS BOOT CONFIGURATION (R-boot) — one explicit contract for both boot seams.
//
// WHAT PROBLEM THIS SOLVES
// ------------------------
// `startHarnessServer` and the service runtime used to default to the SHIPPED catalogue
// (`createHarnessRegistry()`), the full shared toolbox and the generated built-in plugin
// set. That made "start a harness" mean "start the package's product", so a host (today
// @packages/erosire/create-storyline, tomorrow anything embedding the server) could not
// state its OWN templates, agents, plugins or tools: the omitted fields silently came
// back, and the host had no seam to remove them.
//
// This module is the seam. A caller passes `harness: HarnessBootConfiguration` to
// `startHarnessServer`/`createHarnessRuntime` (and the equivalent `variables.harness` to
// the @underload/service routes + warm-up), and every omitted half is EMPTY:
//
//   presets   omitted  => the registry starts with NO templates at all;
//   plugins   omitted  => NO plugins are applied and NO plugin row is listed;
//   toolbox   omitted  => `sharedToolbox: false`, no environment rows, no extra tools,
//                         so a built harness registers only the harness-owned core
//                         runtime floor (toolRegistry/toolRequest/records/tasks/...).
//
// NOTHING here changes the low-level library: `harness({})` still applies the generated
// `BUILTIN_PLUGINS`, and `createHarnessRegistry()` (no options) still seeds `presets`
// with the historical shared toolbox. Those are explicit caller choices now; the server
// boot is the seam whose defaults moved.
//
// THE SHAPE, AND WHY IT IS DECLARATIVE
// ------------------------------------
// A boot preset is a ROSTER + overrides + a toolbox posture, compiled through
// `createHarnessRegistry([], { creation }).create(...)`. That reuse is deliberate: the
// same validator the HTTP `POST /harnesses` path uses checks every name, rank, entry and
// per-agent map, so a boot configuration cannot declare a team the wire contract would
// reject (and the error messages are the ones an operator already knows). The resulting
// factory is `createProfiledHarness`, so the bundled `shareToolbox`/`extraToolSources`/
// `extraTools`/`toolFolders` posture travels with it.
//
// An ADVANCED caller may pass `create` on a preset to replace that factory. A closure is
// not durable and cannot cross `worker_threads`: a saved session that needs to rebuild
// such a preset must still find the same injected entry in the registry (the existing
// `presetFromRecord` rule), and a lane worker rebuilds from the durable record only. The
// inline/boot contract is what this module owns; that durable/worker limit is unchanged
// and documented in the report rather than papered over.
//
// AN ADVANCED FACTORY DECLARES ITS OWN TOOLS (B1). Nothing at this seam can inspect a
// closure, so the compiled card carries EXACTLY the host's `tools`/`environmentTools`
// statements (an omitted `tools` is `[]`, an omitted row list stays absent). It never
// infers rows from the deployment toolbox, because that would advertise tools the
// factory may never register. The compiled preset also carries NO `template`: it is not
// a rebuildable 'live' template, so a registry PATCH that changes its team is refused
// (409, `HarnessPresetCreation.factory === 'advanced'`) and a frozen-session restore
// reuses the still-available factory only when every executable field matches.
//
// PER-CARD REBUILD METADATA (B4). A profiled card records its effective posture on
// `HarnessPreset.creation.toolbox` (in memory, never durable), so a registry PATCH or a
// frozen-session restore rebuilds THAT card — its explicit empty row list, its per-card
// extra tools/sources/folders, its budget — instead of the deployment-wide
// `HarnessRegistryOptions.creation` default.
//
// PRECEDENCE / CONFLICTS
// ----------------------
//   - an injected `registry` is authoritative: `presets` may not also be configured
//     (the runtime throws) — two sources for "what templates exist" have no honest order;
//   - an injected registry also owns its CREATION DEFAULTS, so a stated `toolbox` beside
//     it is refused (B5): this seam cannot reach into a registry it did not create, and
//     silently ignoring the posture is exactly the bug that refusal fixes. An injected
//     registry WITHOUT `toolbox` keeps working unchanged;
//   - an injected `store` owns its own registry, plugins and toolbox: `harness` may not
//     be configured beside it;
//   - `plugins` and `commands` DO combine with an injected registry, because those are
//     per-BUILD facts (the store forwards them through the report) rather than
//     catalogue construction.
//
// Cross-references:
//   - ./registry.ts     — `createHarnessRegistry` validation, `creationDefaults()`
//   - ./toolbox.ts      — `declaredToolboxNames`, `createToolboxHarness` precedence
//   - ./types.ts        — `HarnessToolboxDefaults`, `HarnessPresetReport.plugins/commands`
//   - ../runtime.ts     — `createHarnessRuntime`/`getHarnessRuntime` consumption
//   - ../start.ts       — `startHarnessServer` consumption
//   - ../../../../service/src/server/harness-warmup.ts — `variables.harness` forwarding

import type { AgentRank } from '../../engine/types';
// The two environment-backed row names the kernel registers. They are the vocabulary an
// explicit `environmentTools` array is resolved against (see `compilePreset`).
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../../engine/harness';
import type {
    HarnessCommandConfiguration,
    HarnessPlugin,
    HarnessPluginMetadata,
    Tool
} from '../../engine/harness';
import { createHarnessRegistry } from './registry';
import { SHARED_TOOL_NAMES, createProfiledHarness, declaredToolboxNames } from './toolbox';
import type { HarnessPreset, HarnessToolboxDefaults } from './types';

// One template the deployment wants in its catalogue. Everything except `name`/`agents`
// is optional and mirrors the existing `HarnessPreset` vocabulary rather than inventing a
// second definition schema.
export type HarnessBootPresetConfiguration = {
    // The catalogue id, also the URL segment (`/harnesses/{name}`). Validated by the
    // registry's own name rule, including the alias reservation and case-insensitive
    // uniqueness across the boot list.
    name: string;
    title?: string;
    description?: string;
    // THE ROSTER: trusted agent profile ids in declaration order. Non-empty; the first
    // name is the routing default when `entry` is omitted. The registry rejects an
    // unknown, duplicated, empty or over-long roster with its normal 400-class message.
    //
    // These are CATALOGUE profiles only. Session-defined custom agents (R7) are session
    // state, not a template declaration: a host that needs one either builds a full
    // `HarnessPreset` with the `create` factory below or supplies an injected `registry`.
    agents: readonly string[];
    // Routing only (must name a member), never authority — see `HarnessPreset.ranks`.
    entry?: string;
    // Authority map, agent id → A–Z rank letter. A sparse map is filled by the registry's
    // own `resolveRosterRanks` rule, so the card and the harness run the same ranks.
    ranks?: Readonly<Record<string, AgentRank>>;
    // The three per-agent override maps, with the same key-membership rules as the wire.
    agentModels?: Readonly<Record<string, string>>;
    agentInstructions?: Readonly<Record<string, string>>;
    agentColors?: Readonly<Record<string, string>>;
    // THE CARD'S DECLARED TOOL NAMES. Omitted => derived from this preset's effective
    // toolbox (`declaredToolboxNames`, which includes the shared set and the card's own
    // extra tools/sources), which is what keeps a zero-toolbox boot from shipping a card
    // that advertises the shared set it does not register. Stated => authoritative (a host
    // may advertise a tool a plugin registers later), INCLUDING an explicit `[]`: an empty
    // declared list is a statement, never "inherit".
    //
    // A STATED LIST ALSO STATES THE SHARED POSTURE (B1): a list containing no
    // `SHARED_TOOL_NAMES` entry is a tool-less card, even under a `sharedToolbox: true`
    // deployment floor. That is what lets a host pass the shipped `HarnessPreset[]`
    // straight through without the tool-less `chat` card inheriting the shared toolbox.
    // An explicit `sharedToolbox` always wins over this inference.
    //
    // WITH AN ADVANCED `create`, this list is the ONLY tool statement: an omitted value
    // means `[]` (nothing is inferred from the deployment toolbox).
    tools?: readonly string[];
    // THE ENVIRONMENT-BACKED ROWS THIS CARD REGISTERS, by tool name (`search`, `fetch`).
    //
    // EXPLICIT LIST => THE COMPLETE PER-CARD SET: the factory's `websearch`/`webfetch`
    // are derived from it, so the list is authoritative for BOTH the card and the runtime.
    // `[]` really clears rows inherited from `HarnessBootConfiguration.toolbox` — an empty
    // override is not an omission. Omitted => the inherited/boolean posture applies and the
    // declared list is derived from it.
    //
    // A stated `websearch`/`webfetch` that contradicts this list is rejected (rather than
    // silently winning one way): the declaration is the card contract, so it must not
    // describe rows the factory does not register.
    environmentTools?: readonly string[];
    // THE PER-PRESET TOOLBOX OVERRIDES. Unset members inherit `HarnessBootConfiguration.
    // toolbox`; stated members win for this card (and only this card). The resolved
    // posture is MATERIALIZED on the compiled card (sharedToolbox/websearch/webfetch are
    // explicit booleans, empty maps/lists stay empty) so a later registry PATCH or
    // frozen-session restore rebuilds this card instead of the deployment default.
    sharedToolbox?: boolean;
    maxIterations?: number;
    // The individual registration knobs. `environmentTools` (above) is the declarative and
    // authoritative form; these are for a card that does not state a list (e.g. a host tool
    // provider registering a row outside the two shipped names).
    websearch?: boolean;
    webfetch?: boolean;
    // EXTRA SOURCES / DEFINITIONS / FOLDERS. REPLACE semantics: a stated map or list (an
    // EMPTY one included) is this card's complete value and replaces the deployment's;
    // omitted inherits it. That is what makes `{}`/`[]` a usable "none for this card"
    // statement instead of another way to say "inherit".
    extraToolSources?: Readonly<Record<string, string>>;
    extraTools?: Readonly<Record<string, Tool>>;
    toolFolders?: readonly string[];
    // ADVANCED: replace the compiled profiled factory entirely. The roster/ranks above are
    // still required, because they are the card metadata every reader projects. A closure
    // is inline-only and not worker-rebuildable (see the header). `tools`/`environmentTools`
    // are the ONLY registration statement this seam can make for it (never inferred), and
    // an executable registry PATCH on the card is refused rather than rebuilt.
    create?: HarnessPreset['create'];
};

// THE ONE BOOT CONTRACT. `harness` is the option member on both server seams, so the same
// object can be handed to `startHarnessServer({ harness })` and, through the service,
// `getHarnessRuntime({ harness })` / `variables.harness`.
export type HarnessBootConfiguration = {
    // The templates this deployment ships. Omitted/[] => an EMPTY catalogue.
    presets?: readonly HarnessBootPresetConfiguration[];
    // The complete plugin set applied to every harness this deployment builds. Omitted/[]
    // => NO plugins and NO plugin rows. Pass the package's `BUILTIN_PLUGINS` (exported
    // from `@underload/harness/server`) to keep the shipped three explicitly.
    plugins?: readonly HarnessPlugin[];
    // The toolbox posture applied where templates are BUILT. Omitted => the ZERO floor:
    // the harness-owned runtime tools only, no shared file/app tools and no web rows.
    //
    //   - every boot-DECLARED preset inherits its unset members (its own per-preset fields,
    //     including a stated `tools` list, win) and the effective posture is recorded on
    //     the compiled card, so a PATCH/restore rebuilds that card rather than this floor;
    //   - a harness created through `POST /harnesses` and a restored registry row use it
    //     through `HarnessRegistryOptions.creation`;
    //   - an explicitly supplied `HarnessPreset` factory keeps its own captured posture —
    //     passing the shipped `presets` therefore keeps the shipped toolboxes (the
    //     `chat` card's tool-less declaration included).
    //
    // An INJECTED `registry` owns its own creation defaults, so stating this member beside
    // one is refused (B5) instead of being silently ignored. Omit it to keep an injected
    // registry valid.
    //
    // This reaches SESSION harnesses only. It does NOT populate the DIRECT-CALL catalogue —
    // `GET /tools` / `POST /tools/{name}` — which is the separate `catalogue` seam. The
    // server seams default that catalogue to EMPTY (the zero-default contract); a host that
    // wants the production rows passes `createToolCatalogue()` explicitly.
    toolbox?: HarnessToolboxDefaults;
    // Slash commands registered on every harness (after the kernel's built-ins).
    commands?: readonly HarnessCommandConfiguration[];
};

// The RESOLVED form the boot seams construct with. `toolbox.sharedToolbox` is always an
// explicit boolean here (the zero floor unless the host stated otherwise), and the plugin
// catalogue is DERIVED from the executable list so a row can never describe a plugin the
// harnesses do not load (or the reverse) — `createPluginSettingsStore` takes exactly this.
export type ResolvedHarnessBootConfiguration = {
    presets: readonly HarnessPreset[];
    plugins: readonly HarnessPlugin[];
    pluginDescriptors: readonly HarnessPluginMetadata[];
    toolbox: HarnessToolboxDefaults;
    commands: readonly HarnessCommandConfiguration[];
};

// A plain-object check shared by every untrusted member. `variables.harness` arrives from
// the service loader, so the resolver is the edge that must fail with a sentence rather
// than a property access on `undefined`.
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, where: string): Record<string, unknown> => {
    if (!isPlainObject(value)) {
        throw new Error(`The harness boot configuration ${where} must be a plain object.`);
    }

    return value;
};

const requireString = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`The harness boot configuration ${where} must be a non-empty string.`);
    }

    return value;
};

const optionalBoolean = (value: unknown, where: string): boolean | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'boolean') {
        throw new Error(`The harness boot configuration ${where} must be true or false.`);
    }

    return value;
};

// Positive safe integer (or Infinity). `createToolboxHarness` forwards the value to the
// kernel, but a boot declaration is compiled BEFORE a harness exists, so an invalid budget
// would otherwise surface only on the first session — after the listener is already up.
const optionalMaxIterations = (value: unknown, where: string): number | undefined => {
    if (value === undefined) return undefined;

    if (
        typeof value !== 'number' ||
        Number.isNaN(value) ||
        value <= 0 ||
        (Number.isFinite(value) && !Number.isSafeInteger(value))
    ) {
        throw new Error(
            `The harness boot configuration ${where} must be a positive safe integer or Infinity.`
        );
    }

    return value;
};

const optionalStringMap = (value: unknown, where: string): Record<string, string> | undefined => {
    if (value === undefined) return undefined;

    const source = requireObject(value, where);
    const result: Record<string, string> = {};

    for (const [key, entry] of Object.entries(source)) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw new Error(`The harness boot configuration ${where}.${key} must be a non-empty path string.`);
        }

        result[key] = entry;
    }

    return result;
};

const optionalToolMap = (value: unknown, where: string): Record<string, Tool> | undefined => {
    if (value === undefined) return undefined;

    const source = requireObject(value, where);
    const result: Record<string, Tool> = {};

    for (const [key, entry] of Object.entries(source)) {
        // A `Tool` is a CALLABLE object (`tool()` returns a function carrying `name`,
        // `description`, `tags`, ... — ../../types `Tool`), so a plain-object check is wrong
        // here. Both shapes are accepted; the one invariant the boot edge can check is that
        // it states a name.
        const callable = typeof entry === 'function' || isPlainObject(entry);

        if (!callable || typeof (entry as { name?: unknown }).name !== 'string') {
            throw new Error(`The harness boot configuration ${where}.${key} must be a tool definition.`);
        }

        result[key] = entry as unknown as Tool;
    }

    return result;
};

const optionalStringList = (value: unknown, where: string): string[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`The harness boot configuration ${where} must be an array of strings.`);
    }

    return [...value];
};

// The toolbox, resolved to the ZERO floor and then layered with the host's declarations.
//
// `sharedToolbox` IS materialised: `createToolboxHarness` treats an absent value as `true`,
// so leaving it out here would silently restore the shared set on the very seam whose job
// is to make omission mean "none". The two environment rows are deliberately left ABSENT
// unless the host stated them, because their contract is "follow the effective shared
// flag" — a preset that opts into `sharedToolbox: true` must then also get both rows, and
// materialising a boot-level `false` here would wrongly pin it off for that card.
const resolveToolbox = (value: unknown): HarnessToolboxDefaults => {
    if (value === undefined) {
        return { sharedToolbox: false };
    }

    const source = requireObject(value, 'toolbox');
    const sharedToolbox = optionalBoolean(source.sharedToolbox, 'toolbox.sharedToolbox') ?? false;
    const websearch = optionalBoolean(source.websearch, 'toolbox.websearch');
    const webfetch = optionalBoolean(source.webfetch, 'toolbox.webfetch');
    const maxIterations = optionalMaxIterations(source.maxIterations, 'toolbox.maxIterations');
    const extraToolSources = optionalStringMap(source.extraToolSources, 'toolbox.extraToolSources');
    const extraTools = optionalToolMap(source.extraTools, 'toolbox.extraTools');
    const toolFolders = optionalStringList(source.toolFolders, 'toolbox.toolFolders');

    return {
        sharedToolbox,
        ...(websearch === undefined ? {} : { websearch }),
        ...(webfetch === undefined ? {} : { webfetch }),
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(extraToolSources === undefined ? {} : { extraToolSources }),
        ...(extraTools === undefined ? {} : { extraTools }),
        ...(toolFolders === undefined ? {} : { toolFolders })
    };
};

// THE EFFECTIVE PER-CARD POSTURE (B1). ONE resolver feeds both the compiler and the boot
// signature, so "what the card declares" and "what the signature compares" can never
// drift. Everything it returns is fully materialized: `sharedToolbox`, `websearch` and
// `webfetch` are explicit booleans (no consumer has to re-apply the `?? shared` rule),
// and an explicitly empty map/list stays empty.
type ResolvedPresetDeclaration = {
    // A host-supplied factory replaced the profiled one.
    advanced: boolean;
    // The posture the PROFILED factory runs with. Unused (but validated) for advanced
    // factories: the declaration below is the only thing a reader may project.
    toolbox: HarnessToolboxDefaults;
    // The card's declared catalogue tool names. For an advanced factory this is exactly
    // what the host stated (an omitted list is `[]`): the boot seam must NOT infer what an
    // opaque closure registers from the deployment toolbox.
    tools: readonly string[];
    // The environment-backed rows. `undefined` means "not stated and the effective posture
    // declares none", which keeps the historical absent-field shape; `[]` is a STATEMENT
    // (an explicit empty override) and is preserved as one.
    environmentTools: readonly string[] | undefined;
};

const resolvePresetDeclaration = (
    source: Record<string, unknown>,
    where: string,
    name: string,
    bootToolbox: HarnessToolboxDefaults
): ResolvedPresetDeclaration => {
    // REBUILDABILITY IS DECIDED BY THE TEMPLATE VOCABULARY (B4), not guessed. A host that
    // passes a full `HarnessPreset` (the shipped `presets`, dev.ts, the release smoke)
    // states `template: 'live'`: that is the registry's own "this factory can be rebuilt
    // from a roster/map patch" marker, so the compiled card records a PROFILED `creation`
    // on the effective posture below (the tool-less `chat` included) while the SUPPLIED
    // closure still runs at boot unchanged (see `compilePreset`). An inline boot `create`
    // states no template, so it stays advanced: exact closure preserved, never rebuilt,
    // never substituted. A `scripted`/`flaky` source factory is likewise not reconstructed.
    const advanced = source.create !== undefined && source.template !== 'live';
    const statedTools = optionalStringList(source.tools, `${where}.tools`);
    const statedEnvironment = optionalStringList(source.environmentTools, `${where}.environmentTools`);
    const statedShared = optionalBoolean(source.sharedToolbox, `${where}.sharedToolbox`);
    const statedWebsearch = optionalBoolean(source.websearch, `${where}.websearch`);
    const statedWebfetch = optionalBoolean(source.webfetch, `${where}.webfetch`);
    // THE REGISTRATION KNOBS FOLLOW THE SAME OMITTED/STATED RULE (empty-vs-omitted above):
    // a stated map/list replaces the deployment's (an EMPTY one clears it), an omitted one
    // inherits it. Resolving the inheritance HERE is what keeps the recorded card posture
    // equal to what the factory actually captures.
    const statedMaxIterations = optionalMaxIterations(source.maxIterations, `${where}.maxIterations`);
    const statedExtraToolSources = optionalStringMap(source.extraToolSources, `${where}.extraToolSources`);
    const statedExtraTools = optionalToolMap(source.extraTools, `${where}.extraTools`);
    const statedToolFolders = optionalStringList(source.toolFolders, `${where}.toolFolders`);
    const maxIterations = statedMaxIterations ?? bootToolbox.maxIterations;
    const extraToolSources = statedExtraToolSources ?? bootToolbox.extraToolSources;
    const extraTools = statedExtraTools ?? bootToolbox.extraTools;
    const toolFolders = statedToolFolders ?? bootToolbox.toolFolders;

    // A STATED `tools` LIST IS ALSO A STATEMENT ABOUT THE SHARED TOOLBOX (B1). Hosts pass
    // the shipped `HarnessPreset[]` straight through (dev.ts, the release smoke), and a
    // preset's toolbox lives in its closure rather than in a field, so the only per-card
    // statement available is its declaration. Reading a list with no shared name as "this
    // card is tool-less" is what keeps `chat` tool-less under a shared deployment floor:
    // the previous rule inherited `sharedToolbox: true` from the floor and silently
    // registered (and advertised) the whole shared set for a card that never claimed it.
    // An explicit `sharedToolbox` always wins over this inference.
    const sharedToolbox =
        statedShared ??
        (statedTools === undefined
            ? bootToolbox.sharedToolbox === true
            : SHARED_TOOL_NAMES.some((tool) => statedTools.includes(tool)));

    // AN EXPLICIT `environmentTools` IS AUTHORITATIVE FOR REGISTRATION TOO. Deriving both
    // booleans from the stated list is what makes the declaration and the runtime one fact:
    // `[]` clears rows an inherited floor would otherwise add, and `['fetch']` cannot
    // register `search`.
    const wantsSearch =
        statedEnvironment === undefined ? undefined : statedEnvironment.includes(WEB_SEARCH_TOOL_NAME);
    const wantsFetch =
        statedEnvironment === undefined ? undefined : statedEnvironment.includes(WEB_FETCH_TOOL_NAME);

    // A contradictory pair is a configuration bug with two possible "winners"; refuse it
    // rather than persist a card whose declaration and factory disagree.
    if (wantsSearch !== undefined && statedWebsearch !== undefined && statedWebsearch !== wantsSearch) {
        throw new Error(
            `The harness boot configuration ${where} ("${name}") sets websearch to ${String(statedWebsearch)} but its environmentTools ${
                wantsSearch ? 'lists' : 'does not list'
            } "${WEB_SEARCH_TOOL_NAME}". State the row once: list "${WEB_SEARCH_TOOL_NAME}" in environmentTools when websearch is true, or omit the websearch override.`
        );
    }

    if (wantsFetch !== undefined && statedWebfetch !== undefined && statedWebfetch !== wantsFetch) {
        throw new Error(
            `The harness boot configuration ${where} ("${name}") sets webfetch to ${String(statedWebfetch)} but its environmentTools ${
                wantsFetch ? 'lists' : 'does not list'
            } "${WEB_FETCH_TOOL_NAME}". State the row once: list "${WEB_FETCH_TOOL_NAME}" in environmentTools when webfetch is true, or omit the webfetch override.`
        );
    }

    // THE INHERITANCE CHAIN, resolved once and materialized. A stated row list wins, then a
    // stated per-card boolean, then the deployment's explicit boolean, then the card's OWN
    // effective shared flag — which is why `sharedToolbox: false` with no row statement
    // registers neither environment row, exactly like `createToolboxHarness` would.
    const websearch = wantsSearch ?? statedWebsearch ?? bootToolbox.websearch ?? sharedToolbox;
    const webfetch = wantsFetch ?? statedWebfetch ?? bootToolbox.webfetch ?? sharedToolbox;

    const toolbox: HarnessToolboxDefaults = {
        sharedToolbox,
        websearch,
        webfetch,
        ...(maxIterations === undefined ? {} : { maxIterations }),
        // PROVIDED (EVEN EMPTY) REPLACES; OMITTED INHERITS. A spread of the boot map here
        // would make an explicit `{}` a no-op, which is the same empty-vs-omitted ambiguity.
        ...(extraToolSources === undefined ? {} : { extraToolSources: { ...extraToolSources } }),
        ...(extraTools === undefined ? {} : { extraTools: { ...extraTools } }),
        ...(toolFolders === undefined ? {} : { toolFolders: [...toolFolders] })
    };

    // AN ADVANCED FACTORY DECLARES ITS OWN BEHAVIOUR (B1). Nothing here can inspect a
    // closure, so the card's listing is exactly what the host stated — an omitted `tools`
    // is `[]` and an omitted `environmentTools` stays absent. Inferring rows from the
    // deployment toolbox would advertise tools the factory may never register.
    if (advanced) {
        return {
            advanced,
            toolbox,
            tools: statedTools ?? [],
            environmentTools: statedEnvironment
        };
    }

    // A profiled card's declaration FOLLOWS its effective posture unless the host stated
    // it. This is the same derivation `registry.create()` applies to an HTTP-created
    // harness, so a boot card and a created card cannot disagree about what they promise.
    // `declaredToolboxNames` now includes the card's extra tools/sources (B8), which is
    // what keeps a runtime-registered tool visible on the card.
    const derived = declaredToolboxNames(toolbox);

    return {
        advanced,
        toolbox,
        tools: statedTools ?? derived.tools,
        environmentTools:
            statedEnvironment ??
            (derived.environmentTools.length === 0 ? undefined : derived.environmentTools)
    };
};

// One declared preset → the executable `HarnessPreset`. The `creation` registry is the
// SAME validator the HTTP create route uses (see the header); it is created once per boot
// resolution and also enforces uniqueness across the declared list. It is a VALIDATION
// registry only: `attachAgentState: false` keeps resolution free of process-global effects
// (B2 — it used to replace the running server's agent overlay with an empty one).
const compilePreset = (
    value: unknown,
    index: number,
    creation: ReturnType<typeof createHarnessRegistry>,
    bootToolbox: HarnessToolboxDefaults
): HarnessPreset => {
    const where = `presets[${index}]`;
    const source = requireObject(value, where);
    const name = requireString(source.name, `${where}.name`);

    if (!Array.isArray(source.agents)) {
        throw new Error(`The harness boot configuration ${where}.agents must be a non-empty array of agent ids.`);
    }

    if (source.create !== undefined && typeof source.create !== 'function') {
        throw new Error(`The harness boot configuration ${where}.create must be a preset factory function.`);
    }

    // Everything semantic (known agents, membership, rank letters, bounds, name shape,
    // duplicates) is the registry's. Wrap its error so an operator can point at the entry
    // in the boot document that caused it.
    let base: HarnessPreset;

    try {
        base = creation.create({
            name,
            ...(source.title === undefined ? {} : { title: source.title as string }),
            ...(source.description === undefined ? {} : { description: source.description as string }),
            agents: source.agents as readonly string[],
            ...(source.entry === undefined ? {} : { entry: source.entry as string }),
            ...(source.ranks === undefined
                ? {}
                : { ranks: source.ranks as Readonly<Record<string, AgentRank>> }),
            ...(source.agentModels === undefined
                ? {}
                : { agentModels: source.agentModels as Readonly<Record<string, string>> }),
            ...(source.agentInstructions === undefined
                ? {}
                : { agentInstructions: source.agentInstructions as Readonly<Record<string, string>> }),
            ...(source.agentColors === undefined
                ? {}
                : { agentColors: source.agentColors as Readonly<Record<string, string>> })
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        throw new Error(`The harness boot configuration ${where} ("${name}") is invalid: ${message}`);
    }

    // The per-card posture/declaration, resolved by the ONE rule the signature also uses.
    const declaration = resolvePresetDeclaration(source, where, name, bootToolbox);

    // A SUPPLIED FACTORY IS USED VERBATIM; omission compiles one. Two reasons:
    //   - a host that passes a full `HarnessPreset` (the shipped `presets`) keeps the EXACT
    //     closure it shipped (the `chat` card's tool-less factory included), which is what
    //     lets a caller prove the boot compiled its catalogue rather than a lookalike;
    //   - an `advanced` factory must not be replaced at all.
    // The closure compiled for an omitted `create` is built from the resolved per-card
    // posture, exactly like a registry-created preset's, so the declaration IS the card.
    const create =
        source.create === undefined
            ? createProfiledHarness(
                  base.entry,
                  base.agents,
                  base.ranks,
                  base.agentModels ?? {},
                  base.agentInstructions ?? {},
                  base.agentColors ?? {},
                  {},
                  declaration.toolbox
              )
            : (source.create as HarnessPreset['create']);

    // THE CARD IS BUILT EXPLICITLY, NOT BY SPREADING THE VALIDATOR'S PRESET (B1). The
    // scratch registry's `create()` also DERIVES a declaration from the deployment toolbox
    // (`tools`/`environmentTools` for the registry's own posture); spreading it would leak
    // those rows onto an advanced card that never stated them — exactly the inference this
    // seam must not make. Only the validated identity/metadata fields are taken over.
    return {
        name: base.name,
        title: base.title,
        description: base.description,
        // A boot card is built from live trusted agents (the factory above), so it needs a
        // provider exactly like the shipped executable cards do.
        requiresEndpoint: true,
        entry: base.entry,
        ranks: { ...base.ranks },
        agents: [...base.agents],
        tools: [...declaration.tools],
        // An EXPLICIT `environmentTools` is preserved verbatim, including `[]`: the resolved
        // preset must show the card's stated row set. When the list is omitted and the
        // effective posture declares no row, the field is omitted so the historical shape
        // is unchanged.
        ...(declaration.environmentTools === undefined
            ? {}
            : { environmentTools: [...declaration.environmentTools] }),
        // Same absent-when-empty rule the validator uses: a per-agent map no card stated
        // produces no field, so the record shape stays historical.
        ...(base.agentModels === undefined || Object.keys(base.agentModels).length === 0
            ? {}
            : { agentModels: { ...base.agentModels } }),
        ...(base.agentInstructions === undefined || Object.keys(base.agentInstructions).length === 0
            ? {}
            : { agentInstructions: { ...base.agentInstructions } }),
        ...(base.agentColors === undefined || Object.keys(base.agentColors).length === 0
            ? {}
            : { agentColors: { ...base.agentColors } }),
        // A boot preset is a template THIS PROCESS ships, so it takes the built-in flag:
        // a DELETE records a tombstone and a later restart that still declares it does not
        // resurrect the operator's removal. `restoreHarnessRegistry` skips a saved built-in
        // row this build no longer declares, which is exactly what removing it from the
        // boot configuration means.
        builtin: true,
        editable: true,
        // B4: what the factory was built with, so a registry PATCH or a frozen-session
        // restore rebuilds THIS card. An advanced factory is not a rebuildable live
        // template — leaving `template` absent routes it through the durable
        // injected-preset rule (reuse the still-available factory or fail loudly), which
        // is the honest answer for a closure this process cannot reconstruct.
        ...(declaration.advanced ? {} : { template: 'live' as const }),
        creation: declaration.advanced
            ? { factory: 'advanced' as const }
            : { factory: 'profiled' as const, toolbox: declaration.toolbox },
        create
    };
};

// THE PLUGIN CATALOGUE, DERIVED FROM THE EXECUTABLE LIST. `createPluginSettingsStore` takes
// metadata, while `harness()` takes plugins; deriving one from the other is what makes
// `GET /plugins` and a built harness agree. A hand-written plugin with no metadata gets the
// same synthesized entry the plugin host would give it (`name`, title = name, not builtin).
const pluginDescriptorsOf = (plugins: readonly HarnessPlugin[]): HarnessPluginMetadata[] => {
    const seen = new Set<string>();
    const descriptors: HarnessPluginMetadata[] = [];

    for (const plugin of plugins) {
        // The executable name is the settings key the harness reads; a metadata entry that
        // names something else would make `GET /plugins` describe a DIFFERENT plugin than
        // the one whose `api.settings` resolves. That is a host bug, not a naming choice.
        if (plugin.metadata !== undefined && plugin.metadata.name !== plugin.name) {
            throw new Error(
                `The harness boot configuration plugin "${plugin.name}" declares metadata for "${plugin.metadata.name}"; a plugin's metadata name must match its executable name.`
            );
        }

        if (seen.has(plugin.name)) continue;

        seen.add(plugin.name);
        descriptors.push(plugin.metadata ?? { name: plugin.name, title: plugin.name, builtin: false });
    }

    return descriptors;
};

/**
 * Validate and resolve one boot configuration. Called by BOTH server seams before anything
 * is constructed, so a malformed document aborts startup instead of surfacing on the first
 * session (or, worse, being silently ignored by the runtime cache).
 */
export const resolveHarnessBootConfiguration = (
    configuration?: HarnessBootConfiguration
): ResolvedHarnessBootConfiguration => {
    if (configuration === undefined) {
        return {
            presets: [],
            plugins: [],
            pluginDescriptors: [],
            toolbox: resolveToolbox(undefined),
            commands: []
        };
    }

    const source = requireObject(configuration, 'root');
    const toolbox = resolveToolbox(source.toolbox);

    // Plugins are taken as executable entries; the name is the only member the boot seam
    // itself validates, because it is what the catalogue row and the settings keys use.
    const plugins: HarnessPlugin[] = [];

    if (source.plugins !== undefined) {
        if (!Array.isArray(source.plugins)) {
            throw new Error('The harness boot configuration plugins must be an array of plugin entries.');
        }

        for (const [index, entry] of source.plugins.entries()) {
            const plugin = requireObject(entry, `plugins[${index}]`);

            if (typeof plugin.name !== 'string' || plugin.name.trim().length === 0) {
                throw new Error(`The harness boot configuration plugins[${index}].name must be a non-empty string.`);
            }

            // `setup`/`metadata` are the two members the plugin host reads; a mistyped one
            // would otherwise surface only when the first session is built.
            if (plugin.setup !== undefined && typeof plugin.setup !== 'function') {
                throw new Error(
                    `The harness boot configuration plugins[${index}].setup must be a function when present.`
                );
            }

            if (plugin.metadata !== undefined && !isPlainObject(plugin.metadata)) {
                throw new Error(
                    `The harness boot configuration plugins[${index}].metadata must be a plain object when present.`
                );
            }

            // The plugin host refuses two host plugins with one name (no honest precedence).
            // Failing here names the boot entry instead of the first session's construction.
            if (plugins.some((existing) => existing.name === plugin.name)) {
                throw new Error(
                    `The harness boot configuration plugins[${index}] repeats the name "${String(plugin.name)}"; a plugin may be configured once.`
                );
            }

            plugins.push(entry as HarnessPlugin);
        }
    }

    const commands: HarnessCommandConfiguration[] = [];

    if (source.commands !== undefined) {
        if (!Array.isArray(source.commands)) {
            throw new Error('The harness boot configuration commands must be an array of command entries.');
        }

        for (const [index, entry] of source.commands.entries()) {
            if (!isPlainObject(entry)) {
                throw new Error(`The harness boot configuration commands[${index}] must be a plain object.`);
            }

            commands.push(entry as HarnessCommandConfiguration);
        }
    }

    // PRESETS ARE COMPILED THROUGH A SCRATCH REGISTRY, and only when the host declared some.
    // That registry's `create()` is the validator; its factory is replaced per preset above.
    // Skipping it for an empty list is not an optimisation: `createHarnessRegistry` attaches
    // its agent layer as the PROCESS default, and a host that injected its own registry must
    // keep that registry's layer authoritative.
    let presets: HarnessPreset[] = [];

    if (source.presets !== undefined) {
        if (!Array.isArray(source.presets)) {
            throw new Error('The harness boot configuration presets must be an array of preset declarations.');
        }

        if (source.presets.length > 0) {
            // B2: A VALIDATION-ONLY REGISTRY. `attachAgentState: false` is what makes this
            // resolution free of process-global effects: without it, compiling a host's
            // boot document installed this scratch catalogue's EMPTY agent layer as the
            // process default, erasing every operator agent edit in the running server
            // (Storyline resolving its harness inside the shared service process did it).
            const creation = createHarnessRegistry([], {
                creation: toolbox,
                attachAgentState: false
            });

            presets = source.presets.map((entry, index) =>
                compilePreset(entry, index, creation, toolbox)
            );
        }
    }

    return {
        presets,
        plugins,
        pluginDescriptors: pluginDescriptorsOf(plugins),
        toolbox,
        commands
    };
};

// ---------------------------------------------------------------------------
// ONE RUNTIME PER ROOT *AND* ONE BOOT CONFIGURATION — the cache guard
// ---------------------------------------------------------------------------
//
// `getHarnessRuntime` keeps ONE runtime per resolved database root (../runtime.ts). The
// first caller decides the settings, so a warm-up that ran with no configuration followed
// by a request that HAD one used to be indistinguishable from "the host never configured
// anything": the request reused the empty runtime and the host's templates/plugins/tools
// silently disappeared. This signature is the comparison that turns that into a loud
// failure.
//
// It is computed from the RAW configuration (the same value the host passes twice), never
// from the resolved one: resolution compiles fresh factories on every call, so comparing
// resolved objects would report a conflict between two calls that stated the same thing.
//
// CANONICALIZED BY NORMALIZED SEMANTICS (B7). A naive structural dump made every
// semantically equal spelling of the zero floor a CONFLICT: a warm-up that passed
// `variables.harness = { presets: [], plugins: [], toolbox: { sharedToolbox: false } }`
// and a request that passed `undefined` (or `{}`) described the same runtime but hashed
// differently, so the service failed on its own equivalent configuration. This function
// therefore hashes the RESOLUTION facts, through the same helpers the compiler uses:
//   - an omitted list and an empty list for `presets`/`plugins`/`commands` are one empty list;
//   - `toolbox` is materialized (sharedToolbox/websearch/webfetch are explicit booleans,
//     so `{}`, `{sharedToolbox:false}` and `{sharedToolbox:false, websearch:false,
//     webfetch:false}` are one posture, while `{sharedToolbox:true}` still differs);
//   - a preset hashes its effective declaration (so `environmentTools: ['search']` and
//     `websearch: true` agree) — and an ADVANCED `create` factory hashes only what the
//     host stated, because nothing can infer a closure's behaviour;
//   - maps are written in sorted key order;
//   - `Infinity` is tagged rather than left to `JSON.stringify`'s `null`, so a budget of
//     `Infinity` never compares equal to an absent/invalid one;
//   - functions are assigned stable process-local ids: the same closure compares equal and
//     a different closure does not. That identity is process-local on purpose (an id is
//     the only honest equality a function has), which is enough for the per-root cache.
const functionIds = new WeakMap<Function, number>();
let nextFunctionId = 1;

const functionIdentity = (value: Function): string => {
    let id = functionIds.get(value);

    if (id === undefined) {
        id = nextFunctionId;
        nextFunctionId += 1;
        functionIds.set(value, id);
    }

    return `function#${id}`;
};

// A JSON-safe canonical projection of arbitrary configuration data. Cycles are marked
// rather than followed, and every non-finite number keeps its own tag (see above).
const canonicalOf = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === 'function') return functionIdentity(value);

    if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;

        return Number.isNaN(value) ? '[NaN]' : value > 0 ? '[Infinity]' : '[-Infinity]';
    }

    if (Array.isArray(value)) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);

        const list = value.map((entry) => canonicalOf(entry, seen));

        seen.delete(value);
        return list;
    }

    if (isPlainObject(value)) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);

        // SORTED KEYS: a map's insertion order is not a statement (the compiler copies it
        // into an object the kernel reads by name), so two equivalent documents with a
        // different order must not read as a conflict.
        const entries = Object.keys(value)
            .sort()
            .map((key) => [key, canonicalOf(value[key], seen)] as const);
        const result = Object.fromEntries(entries);

        seen.delete(value);
        return result;
    }

    return value === undefined ? '[undefined]' : value;
};

const canonical = (value: unknown): unknown => canonicalOf(value, new WeakSet<object>());

// One canonical toolbox: the ZERO-FLOOR-normalized form. `resolveToolbox` is the same
// function the resolver uses, so a spelling it accepts and normalizes hashes identically.
const canonicalToolboxOf = (toolbox: HarnessToolboxDefaults): Record<string, unknown> => {
    const shared = toolbox.sharedToolbox === true;

    return {
        sharedToolbox: shared,
        // Materialized: a legacy omission means "follow shared", so `{sharedToolbox:false}`
        // and `{sharedToolbox:false, websearch:false, webfetch:false}` are one posture.
        websearch: toolbox.websearch ?? shared,
        webfetch: toolbox.webfetch ?? shared,
        // `null` is the absent tag; a number (or the `[Infinity]` tag) is a real budget.
        maxIterations: toolbox.maxIterations === undefined ? null : canonical(toolbox.maxIterations),
        extraToolSources: canonical(toolbox.extraToolSources ?? {}),
        extraTools: canonical(toolbox.extraTools ?? {}),
        toolFolders: [...(toolbox.toolFolders ?? [])]
    };
};

const canonicalPresetDeclarationOf = (
    value: unknown,
    index: number,
    bootToolbox: HarnessToolboxDefaults
): unknown => {
    const where = `presets[${index}]`;
    const source = requireObject(value, where);
    const name = requireString(source.name, `${where}.name`);
    // The SAME posture/declaration resolution the compiler runs, so the signature can
    // never disagree with the card that resolution produces.
    const declaration = resolvePresetDeclaration(source, where, name, bootToolbox);

    return {
        name,
        title: source.title === undefined ? null : canonical(source.title),
        description: source.description === undefined ? null : canonical(source.description),
        agents: canonical(source.agents ?? []),
        entry: source.entry === undefined ? null : canonical(source.entry),
        ranks: canonical(source.ranks ?? {}),
        agentModels: canonical(source.agentModels ?? {}),
        agentInstructions: canonical(source.agentInstructions ?? {}),
        agentColors: canonical(source.agentColors ?? {}),
        tools: [...declaration.tools],
        // `null` distinguishes "no rows declared" from an explicit empty statement only in
        // the COMPILED card (which keeps `[]`); for BEHAVIOUR both register nothing, so the
        // canonical form folds them together.
        environmentTools: [...(declaration.environmentTools ?? [])],
        // An advanced factory's posture is not its behaviour (nothing here reads it), so
        // only the stated rows and the closure identity participate. A profiled card's
        // posture IS its behaviour and participates in full.
        posture: declaration.advanced
            ? null
            : {
                  sharedToolbox: declaration.toolbox.sharedToolbox === true,
                  websearch: declaration.toolbox.websearch === true,
                  webfetch: declaration.toolbox.webfetch === true,
                  maxIterations:
                      declaration.toolbox.maxIterations === undefined
                          ? null
                          : canonical(declaration.toolbox.maxIterations),
                  extraToolSources: canonical(declaration.toolbox.extraToolSources ?? {}),
                  extraTools: canonical(declaration.toolbox.extraTools ?? {}),
                  toolFolders: [...(declaration.toolbox.toolFolders ?? [])]
              },
        // The profiled factory is a pure function of the fields above, so it needs no id;
        // a host closure does.
        factory: declaration.advanced
            ? functionIdentity(source.create as Function)
            : '[profiled]'
    };
};

/**
 * A stable textual identity for a boot configuration, used by the per-root runtime cache
 * to refuse a second, DIFFERENT configuration instead of silently reusing the first one.
 * Semantically equal spellings of the zero floor compare equal — `undefined`, `{}`,
 * `{presets:[]}`, `{plugins:[]}`, `{commands:[]}`, `{toolbox:{}}` and
 * `{toolbox:{sharedToolbox:false}}` are ONE configuration (B7) — while a different
 * toolbox, preset list, plugin set, command list or executable factory still conflicts.
 */
export const harnessBootSignature = (configuration?: HarnessBootConfiguration): string => {
    const source = configuration === undefined ? {} : requireObject(configuration, 'root');
    const toolbox = resolveToolbox(source.toolbox);

    const presetsOf = (): unknown[] => {
        if (source.presets === undefined) return [];

        if (!Array.isArray(source.presets)) {
            throw new Error('The harness boot configuration presets must be an array of preset declarations.');
        }

        return source.presets.map((entry, index) =>
            canonicalPresetDeclarationOf(entry, index, toolbox)
        );
    };

    const pluginsOf = (): unknown[] => {
        if (source.plugins === undefined) return [];

        if (!Array.isArray(source.plugins)) {
            throw new Error('The harness boot configuration plugins must be an array of plugin entries.');
        }

        return source.plugins.map((entry, index) => {
            const plugin = requireObject(entry, `plugins[${index}]`);

            return {
                name: plugin.name === undefined ? null : canonical(plugin.name),
                setup: typeof plugin.setup === 'function' ? functionIdentity(plugin.setup) : null,
                metadata: canonical(plugin.metadata ?? null)
            };
        });
    };

    const commandsOf = (): unknown[] => {
        if (source.commands === undefined) return [];

        if (!Array.isArray(source.commands)) {
            throw new Error('The harness boot configuration commands must be an array of command entries.');
        }

        return source.commands.map((entry, index) => {
            if (!isPlainObject(entry)) {
                throw new Error(`The harness boot configuration commands[${index}] must be a plain object.`);
            }

            return canonical(entry);
        });
    };

    return JSON.stringify({
        presets: presetsOf(),
        plugins: pluginsOf(),
        commands: commandsOf(),
        // The deployment posture participates for every configuration: a deployment that
        // changed its floor is a different runtime even when its preset list is empty.
        toolbox: canonicalToolboxOf(toolbox)
    });
};
