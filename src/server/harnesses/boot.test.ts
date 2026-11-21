// R-boot — the shared harness boot configuration.
//
// WHAT THIS FILE PINS (one block per acceptance criterion):
//   1. ZERO DEFAULTS: `resolveHarnessBootConfiguration()` / a bare runtime / a bare
//      listener carry NO shipped preset, NO plugin (and no plugin row) and the
//      harness-owned core toolbox floor. That is the deliberate contract change.
//   2. EXPLICIT CONFIG: declared presets/agents/ranks, an explicit plugin, explicit
//      extra tools and tool sources are honoured by a SESSION, not only by the card.
//   3. PARITY: the direct runtime, the standalone listener and the service handler
//      (through `variables.harness`) build the SAME catalogue/plugins/toolbox from one
//      configuration, and the per-root cache refuses a later, different one instead of
//      silently reusing the first.
//   4. The advanced injections still work: an explicit registry/catalogue is accepted,
//      and combining a registry with `harness.presets` is an explicit error.
//
// Determinism: every expected roster, rank, tool name, plugin name and descriptor list
// is exact. No provider request is made (constructing a harness only builds transports),
// and the ephemeral listener binds loopback port 0. Scratch roots live under the
// repository-root Temp/ (AGENTS.md) and are removed.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, tool, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../../harness';
import type { HarnessCommandConfiguration, HarnessPlugin, HarnessProgress } from '../../harness';
import { agentProfiles } from '../../agents';
import { BUILTIN_PLUGINS } from '../../plugin/manifest';
import { createHarnessServiceHandler } from '../service';
import type { ServiceEndpointContext, ServiceEndpointParameters } from '../service';
import { createHarnessRuntime, getHarnessRuntime, setHarnessRuntime } from '../runtime';
import { startHarnessServer } from '../start';
import {
    attachDefaultAgentState,
    createAgentState,
    defaultAgentState,
    effectiveAgentProfile
} from './agent-state';
import { harnessBootSignature, resolveHarnessBootConfiguration } from './boot';
import type { HarnessBootConfiguration, HarnessBootPresetConfiguration } from './boot';
import { createCoreToolEntries, createToolCatalogue, describeHarness } from './index';
import { presets } from './presets';
import { createHarnessRegistry } from './registry';
import {
    SHARED_APP_TOOL_FOLDER,
    SHARED_APP_TOOL_SOURCES,
    SHARED_TOOL_NAMES,
    agentsFromProfiles,
    createToolboxHarness
} from './toolbox';
import type { HarnessPreset } from './types';

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'boot-model'
};

const DEFAULTS = { baseURL: 'http://provider.test/v1', model: 'boot-model', hasApiKey: true };

const progress: HarnessProgress = async () => undefined;

// The probe tool is a CONSTRUCTED definition, which is exactly the kind the boot
// `toolbox.extraTools` map exists to register. Its shape is the one a host writes.
const probeTool = tool<Record<string, never>, { boot: true }>({
    description: 'Boot probe tool.',
    tags: ['boot', 'probe'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ boot: true })
});

// A host plugin with no settings: the boot resolver must still derive a catalogue row
// (`name`, title = name, not builtin) so `GET /plugins` and the loaded set agree.
const probePlugin: HarnessPlugin = {
    name: 'boot-probe',
    metadata: { name: 'boot-probe', title: 'Boot probe', builtin: false, settings: [] },
    setup: () => undefined
};

// A host slash command, i.e. the EXECUTABLE half of the boot `commands` list. It rides
// `HarnessPresetReport.commands` into `createToolboxHarness` rather than the card, so only
// running it on a built session proves the seam carried a handler; a resolver row does not.
const probeCommand: HarnessCommandConfiguration = {
    name: 'probe-command',
    description: 'Report the boot probe.',
    execute: () => ({ content: 'probe command ran' })
};

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const findWorkspaceRoot = (from: string): string | undefined => {
    let current = resolve(from);

    for (let depth = 0; depth < 8; depth += 1) {
        const parent = dirname(current);

        if (parent === current) return undefined;

        if (existsSync(join(parent, 'AGENTS.md')) && existsSync(join(parent, 'package.json'))) return parent;

        current = parent;
    }

    return undefined;
};

const WORKSPACE_ROOT = findWorkspaceRoot(PACKAGE_ROOT) ?? PACKAGE_ROOT;
const SCRATCH_ROOT = join(WORKSPACE_ROOT, 'Temp', 'coding-harness-boot');

const roots: string[] = [];

const scratchRoot = async (prefix: string): Promise<string> => {
    await mkdir(join(WORKSPACE_ROOT, 'Temp'), { recursive: true });
    await mkdir(SCRATCH_ROOT, { recursive: true });

    const root = await mkdtemp(join(SCRATCH_ROOT, prefix));

    roots.push(root);

    return root;
};

afterAll(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Search keys are resolved when a harness is CONSTRUCTED (not when the boot configuration is
// resolved), and the environment-override cases below need to observe `search` as well as the
// keyless `fetch`. Every test that stubs one restores the process environment here.
afterEach(() => {
    vi.unstubAllEnvs();
});

// One explicit configuration used by the parity block. A declarative preset (instruct at
// rank A, general at rank B so `delegate` exists) plus one host plugin and one host tool.
const explicitConfiguration = (): HarnessBootConfiguration => ({
    presets: [
        {
            name: 'boot-team',
            title: 'Boot team',
            description: 'A boot-declared roster.',
            agents: ['instruct', 'general'],
            entry: 'instruct',
            ranks: { instruct: 'A', general: 'B' },
            tools: ['probeTool'],
            environmentTools: []
        }
    ],
    plugins: [probePlugin],
    toolbox: {
        sharedToolbox: false,
        extraTools: { probeTool }
    }
});

const createBareRuntime = () =>
    createHarnessRuntime({
        settings: SETTINGS,
        defaults: DEFAULTS,
        loadEnvironment: false
    });

const handlerCall = async (
    variables: Record<string, unknown>,
    method: string,
    pathname: string
): Promise<{ status: number; body: any }> => {
    const handler = createHarnessServiceHandler();
    const context: ServiceEndpointContext = {
        req: {
            path: pathname,
            header: () => undefined,
            raw: { method, signal: new AbortController().signal }
        }
    };
    const parameters: ServiceEndpointParameters = { body: {}, query: {} };
    const result = await handler(context, parameters, variables);

    expect(result.raw).toBeUndefined();

    return { status: result.status, body: result.response };
};

describe('R-boot 1 — omission means empty', () => {
    it('resolves an absent configuration to the exact zero floor', () => {
        expect(resolveHarnessBootConfiguration()).toEqual({
            presets: [],
            plugins: [],
            pluginDescriptors: [],
            toolbox: { sharedToolbox: false },
            commands: []
        });
    });

    it('a bare runtime has no preset catalogue and no plugin rows', () => {
        const runtime = createBareRuntime();

        expect(runtime.registry.list()).toEqual([]);
        expect(runtime.store.pluginSettings.descriptors).toEqual([]);
        expect(runtime.harnessConfiguration).toBeUndefined();
        expect(runtime.bootSignature).toBe(harnessBootSignature(undefined));
    });

    it('a bare listener lists no harness and no plugin row', async () => {
        const listener = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            expect(listener.store.pluginSettings.descriptors).toEqual([]);
            expect(listener.store.pluginSettings.names()).toEqual([]);

            // The catalogue over the real HTTP mount, because the store keeps its registry
            // private: an empty `items` is the zero-default contract end to end.
            const response = await fetch(`${listener.url}/v1/harness/harnesses`);
            const index = (await response.json()) as { items: unknown[] };

            expect(response.status).toBe(200);
            expect(index.items).toEqual([]);
        } finally {
            await listener.close();
        }
    });
});

describe('R-boot 2 — explicit configuration is honoured', () => {
    it('compiles a declared preset with its exact roster, ranks, tools and plugins', () => {
        const boot = resolveHarnessBootConfiguration(explicitConfiguration());

        expect(boot.presets.map((preset) => preset.name)).toEqual(['boot-team']);

        const [preset] = boot.presets;

        expect({
            name: preset.name,
            title: preset.title,
            description: preset.description,
            entry: preset.entry,
            agents: preset.agents,
            ranks: preset.ranks,
            tools: preset.tools,
            environmentTools: preset.environmentTools,
            builtin: preset.builtin,
            template: preset.template,
            requiresEndpoint: preset.requiresEndpoint
        }).toEqual({
            name: 'boot-team',
            title: 'Boot team',
            description: 'A boot-declared roster.',
            entry: 'instruct',
            agents: ['instruct', 'general'],
            ranks: { instruct: 'A', general: 'B' },
            // The host stated the declaration, so it is authoritative — including the
            // explicitly EMPTY `environmentTools`: empty means empty, not "inherit".
            tools: ['probeTool'],
            environmentTools: [],
            builtin: true,
            template: 'live',
            requiresEndpoint: true
        });

        // The plugin's executable entry AND its catalogue row both come from the one list.
        expect(boot.plugins).toEqual([probePlugin]);
        expect(boot.pluginDescriptors).toEqual([
            { name: 'boot-probe', title: 'Boot probe', builtin: false, settings: [] }
        ]);
        expect(boot.toolbox).toEqual({ sharedToolbox: false, extraTools: { probeTool } });
    });

    it('builds a SESSION on the declared roster, the explicit tool and no shared toolbox', async () => {
        const runtime = createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            harness: explicitConfiguration()
        });

        const created = await runtime.api({
            method: 'POST',
            pathname: '/v1/harness/sessions',
            mount: '/v1/harness',
            readBody: async () => ({ harness: 'boot-team' })
        });

        expect(created.kind).toBe('json');
        expect(created.status).toBe(201);

        const sessionId = (created as { body: { session: { id: string } } }).body.session.id;
        const session = runtime.store.peekSession(sessionId);

        expect(session).toBeDefined();

        const harness = session!.harness;

        // The roster, in the factory's documented ENTRY-FIRST order.
        expect(Object.keys(harness.agents)).toEqual(['instruct', 'general']);
        // The host plugin is applied, and it is the ONLY plugin (no implicit built-ins).
        expect(harness.plugins).toEqual(['boot-probe']);
        // The explicit constructed tool is registered…
        expect(Object.keys(harness.tools)).toContain('probeTool');
        await expect(harness.executeTool('probeTool', {})).resolves.toEqual({ boot: true });
        // …and the shared package/app tools are NOT (the zero toolbox floor).
        for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'files', 'timeNow', 'textCount']) {
            expect(Object.keys(harness.tools)).not.toContain(name);
        }

        // The boot-built SESSION and a direct `createToolboxHarness` on the same posture
        // must register the same tool set: the boot contract does not invent a second path.
        const control = createToolboxHarness(
            {
                agents: agentsFromProfiles(['instruct', 'general'], SETTINGS),
                entry: 'instruct',
                ranks: { instruct: 'A', general: 'B' },
                sharedToolbox: false,
                extraTools: { probeTool }
            },
            SETTINGS,
            progress
        );

        // `actionRequest` is the one deliberate difference: the STORE always supplies the
        // owner-answerer interaction hook (`buildHarness`), which the direct control does
        // not. Everything else — the core floor, `delegate` from the two-rank roster and the
        // explicit host tool — must match exactly.
        expect(Object.keys(harness.tools).sort()).toEqual(
            [...Object.keys(control.tools), 'actionRequest'].sort()
        );
    });

    it('registers a boot-provided command on the live SESSION harness, beside the explicit plugin and tool', async () => {
        // Commands are a per-build fact like plugins: the same explicit preset/plugin/tool
        // posture plus a stated `commands` list must reach the harness the SESSION builds.
        const runtime = createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            harness: { ...explicitConfiguration(), commands: [probeCommand] }
        });

        const created = await runtime.api({
            method: 'POST',
            pathname: '/v1/harness/sessions',
            mount: '/v1/harness',
            readBody: async () => ({ harness: 'boot-team' })
        });

        expect(created.kind).toBe('json');
        expect(created.status).toBe(201);

        const sessionId = (created as { body: { session: { id: string } } }).body.session.id;
        const session = runtime.store.peekSession(sessionId);

        expect(session).toBeDefined();

        const harness = session!.harness;

        // Installed BESIDE the kernel built-ins, in registration order: built-ins first, then
        // the boot list — so the boot command never shadowed one and never replaced the set.
        expect(Object.keys(harness.commands)).toEqual([
            'help',
            'tools',
            'task',
            'websearch',
            'webfetch',
            'probe-command'
        ]);
        expect({
            name: harness.commands['probe-command'].name,
            description: harness.commands['probe-command'].description,
            usage: harness.commands['probe-command'].usage
        }).toEqual({ name: 'probe-command', description: 'Report the boot probe.', usage: undefined });

        // THE POINT OF THIS CASE: the command is EXECUTABLE on this session. The answer is
        // the boot handler's own result, not a metadata row and not a built-in fallback.
        await expect(harness.executeCommand('/probe-command')).resolves.toEqual({
            content: 'probe command ran'
        });

        // The same posture built WITHOUT the boot report carries the built-ins only, so the
        // command can only have arrived through the boot seam (the report), never the card.
        const control = createToolboxHarness(
            {
                agents: agentsFromProfiles(['instruct', 'general'], SETTINGS),
                entry: 'instruct',
                ranks: { instruct: 'A', general: 'B' },
                sharedToolbox: false,
                extraTools: { probeTool }
            },
            SETTINGS,
            progress
        );

        expect(Object.keys(control.commands)).toEqual([
            'help',
            'tools',
            'task',
            'websearch',
            'webfetch'
        ]);

        // The explicit plugin and tool halves of the SAME session are unchanged beside it.
        expect(harness.plugins).toEqual(['boot-probe']);
        await expect(harness.executeTool('probeTool', {})).resolves.toEqual({ boot: true });
    });

    it('applies an explicitly configured built-in plugin set verbatim', () => {
        const boot = resolveHarnessBootConfiguration({ plugins: [...BUILTIN_PLUGINS] });

        // No presets were declared, so the catalogue stays empty; the plugin list is the
        // ONLY thing this configuration states.
        expect(boot.presets).toEqual([]);

        expect(boot.plugins.map((plugin) => plugin.name)).toEqual([
            'async-ping',
            'context-compaction',
            'context-trimmer'
        ]);
        expect(boot.pluginDescriptors.map((descriptor) => descriptor.name)).toEqual([
            'async-ping',
            'context-compaction',
            'context-trimmer'
        ]);
    });
});

// R-boot 2b — EXPLICIT EMPTY OVERRIDES. The compiler used to spread the deployment toolbox
// under every per-preset value, so an explicitly EMPTY array/map (`environmentTools: []`,
// `extraTools: {}`, `extraToolSources: {}`, `toolFolders: []`) was indistinguishable from
// omission and inherited the deployment rows. These cases pin the corrected rule:
//   STATED (even empty) = this card's complete value; OMITTED = inherit.
describe('R-boot 2b — an explicit empty override is empty, not inherited', () => {
    // A boot toolbox with BOTH environment rows ON and no shared toolbox. `fetch` is keyless,
    // so most runtime assertions need no credential; `search` is stubbed only where its
    // ABSENCE must be observed (a keyed host would otherwise register it).
    const environmentCard = (
        preset: Partial<HarnessBootPresetConfiguration> = {}
    ): HarnessBootConfiguration => ({
        presets: [
            {
                name: 'env-card',
                agents: ['general'],
                entry: 'general',
                ranks: { general: 'A' },
                sharedToolbox: false,
                ...preset
            }
        ],
        toolbox: { sharedToolbox: false, websearch: true, webfetch: true }
    });

    const resolvedEnvironmentCard = (
        preset: Partial<HarnessBootPresetConfiguration> = {}
    ): HarnessPreset => resolveHarnessBootConfiguration(environmentCard(preset)).presets[0];

    it('environmentTools: [] clears inherited rows in the declaration AND the harness', () => {
        const preset = resolvedEnvironmentCard({ environmentTools: [] });

        // The declaration is preserved verbatim — empty is observed as empty, not omitted.
        expect(preset.environmentTools).toEqual([]);

        // …and the FACTORY really registers neither row, despite the boot toolbox stating
        // `websearch: true, webfetch: true`. This is the regression the old spread caused.
        const harness = preset.create(SETTINGS, progress);
        const tools = Object.keys(harness.tools);

        expect(tools).not.toContain(WEB_FETCH_TOOL_NAME);
        expect(tools).not.toContain(WEB_SEARCH_TOOL_NAME);
        // The harness-owned core floor is untouched (the card was only cleared, not emptied).
        expect(tools).toContain('toolRequest');
    });

    it('omitting environmentTools still inherits the boot rows', () => {
        const preset = resolvedEnvironmentCard();

        expect(preset.environmentTools).toEqual([WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME]);

        const tools = Object.keys(preset.create(SETTINGS, progress).tools);

        // `fetch` needs no credential, so its presence is deterministic here.
        expect(tools).toContain(WEB_FETCH_TOOL_NAME);
    });

    it('a stated non-empty environmentTools list replaces the inherited set', () => {
        // A configured search key makes `search` registerable; the explicit list omits it,
        // so its absence proves the list — not the boot `websearch: true` — decided.
        vi.stubEnv('EXA_API_KEY', 'boot-env-key');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');

        const preset = resolvedEnvironmentCard({ environmentTools: [WEB_FETCH_TOOL_NAME] });

        expect(preset.environmentTools).toEqual([WEB_FETCH_TOOL_NAME]);

        const tools = Object.keys(preset.create(SETTINGS, progress).tools);

        expect(tools).toContain(WEB_FETCH_TOOL_NAME);
        expect(tools).not.toContain(WEB_SEARCH_TOOL_NAME);
    });

    it('rejects a stated boolean that contradicts the explicit list', () => {
        expect(() =>
            resolveHarnessBootConfiguration(environmentCard({ environmentTools: [], websearch: true }))
        ).toThrow(
            'The harness boot configuration presets[0] ("env-card") sets websearch to true but its environmentTools does not list "search". State the row once: list "search" in environmentTools when websearch is true, or omit the websearch override.'
        );

        expect(() =>
            resolveHarnessBootConfiguration(
                environmentCard({ environmentTools: [WEB_FETCH_TOOL_NAME], webfetch: false })
            )
        ).toThrow(
            'The harness boot configuration presets[0] ("env-card") sets webfetch to false but its environmentTools lists "fetch". State the row once: list "fetch" in environmentTools when webfetch is true, or omit the webfetch override.'
        );
    });

    it('tools: [] stays an empty declaration while omission derives from the shared posture', () => {
        const sharedCard = (preset: Partial<HarnessBootPresetConfiguration> = {}): HarnessPreset =>
            resolveHarnessBootConfiguration({
                presets: [
                    {
                        name: 'shared-card',
                        agents: ['general'],
                        sharedToolbox: true,
                        ...preset
                    }
                ],
                toolbox: { sharedToolbox: false }
            }).presets[0];

        expect(sharedCard().tools).toEqual([...SHARED_TOOL_NAMES]);
        expect(sharedCard({ tools: [] }).tools).toEqual([]);
    });

    it('extraTools: {} replaces (clears) the boot definitions; omission inherits', () => {
        const configuration = (preset: Partial<HarnessBootPresetConfiguration>): HarnessBootConfiguration => ({
            presets: [{ name: 'extra-card', agents: ['general'], sharedToolbox: false, ...preset }],
            toolbox: { sharedToolbox: false, extraTools: { probeTool } }
        });

        const inherited = resolveHarnessBootConfiguration(configuration({})).presets[0];
        const cleared = resolveHarnessBootConfiguration(configuration({ extraTools: {} })).presets[0];

        expect(Object.keys(inherited.create(SETTINGS, progress).tools)).toContain('probeTool');
        expect(Object.keys(cleared.create(SETTINGS, progress).tools)).not.toContain('probeTool');
    });

    it('extraToolSources: {} replaces the boot source map; omission inherits', () => {
        const configuration = (preset: Partial<HarnessBootPresetConfiguration>): HarnessBootConfiguration => ({
            presets: [{ name: 'source-card', agents: ['general'], sharedToolbox: false, ...preset }],
            toolbox: {
                sharedToolbox: false,
                extraToolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow }
            }
        });

        const inherited = resolveHarnessBootConfiguration(configuration({})).presets[0];
        const cleared = resolveHarnessBootConfiguration(configuration({ extraToolSources: {} })).presets[0];

        expect(inherited.create(SETTINGS, progress).toolSource('timeNow')).toBeDefined();
        expect(cleared.create(SETTINGS, progress).toolSource('timeNow')).toBeUndefined();
    });

    it('toolFolders: [] replaces the boot folder list; omission inherits', () => {
        const configuration = (preset: Partial<HarnessBootPresetConfiguration>): HarnessBootConfiguration => ({
            presets: [{ name: 'folder-card', agents: ['general'], sharedToolbox: false, ...preset }],
            toolbox: { sharedToolbox: false, toolFolders: [SHARED_APP_TOOL_FOLDER] }
        });

        const inherited = resolveHarnessBootConfiguration(configuration({})).presets[0];
        const cleared = resolveHarnessBootConfiguration(configuration({ toolFolders: [] })).presets[0];

        // The shared app folder holds `timeNow`; a cleared folder list scans nothing.
        expect(inherited.create(SETTINGS, progress).toolSource('timeNow')).toBeDefined();
        expect(cleared.create(SETTINGS, progress).toolSource('timeNow')).toBeUndefined();
    });
});

describe('R-boot 3 — direct, listener and service share one configuration', () => {
    it('gives the service handler and a direct runtime the same catalogue/plugins', async () => {
        const root = await scratchRoot('boot-service-');
        const configuration = explicitConfiguration();

        // THE SERVICE SEAM: the statically built endpoint module passes no options, so the
        // loader's `variables.harness` is the only channel.
        const listed = await handlerCall({ root, harness: configuration }, 'GET', '/v1/harness/harnesses');

        expect(listed.status).toBe(200);
        expect((listed.body.items as { name: string }[]).map((item) => item.name)).toEqual(['boot-team']);

        // The request path always forwards `variables.harness`; this read pairs with the
        // handler, so it must state the same configuration (the cache guard's whole point).
        const viaService = getHarnessRuntime({ root, harness: configuration });
        const viaDirect = createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            harness: configuration
        });

        expect(viaService.registry.list().map((preset) => preset.name)).toEqual(
            viaDirect.registry.list().map((preset) => preset.name)
        );
        expect(viaService.store.pluginSettings.descriptors).toEqual(
            viaDirect.store.pluginSettings.descriptors
        );
        expect(viaService.bootSignature).toBe(viaDirect.bootSignature);

        // The FIRST caller (the request) decided the runtime for this root. A later call
        // with a DIFFERENT configuration is an explicit error, never a silent reuse.
        expect(() => getHarnessRuntime({ root, harness: { presets: [] } })).toThrow(
            /already created with a DIFFERENT boot configuration/
        );

        // A structurally equal fresh object is NOT a conflict: hosts may compose twice.
        expect(getHarnessRuntime({ root, harness: explicitConfiguration() })).toBe(viaService);

        setHarnessRuntime(undefined, root);
    });

    it('restores a boot-declared session on the same declared preset, toolbox and plugins', async () => {
        const root = await scratchRoot('boot-restart-');
        const configuration = explicitConfiguration();

        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            harness: configuration
        });
        const created = await first.store.create('boot-team');
        const id = created.id;
        const live = first.store.peekSession(id)!;
        const before = Object.keys(live.harness.tools).sort();

        expect(live.harness.plugins).toEqual(['boot-probe']);
        first.store.dispose();

        // A restart over the same root with the SAME configuration: the frozen session
        // rebuilds from its record when the registry entry differs, and the entry itself is
        // recompiled from the declaration. Both must land on the same executable harness.
        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            harness: configuration
        });
        const restored = second.store.peekSession(id);

        expect(restored).toBeDefined();
        expect(Object.keys(restored!.harness.tools).sort()).toEqual(before);
        expect(restored!.harness.plugins).toEqual(['boot-probe']);
        expect(restored!.preset.name).toBe('boot-team');

        second.store.dispose();
    });

    it('lets the standalone listener start from the same explicit configuration', async () => {
        const listener = await startHarnessServer({
            port: 0,
            staticRoot: null,
            harness: explicitConfiguration()
        });

        try {
            expect(listener.harnessConfiguration).toBeDefined();
            expect(listener.store.pluginSettings.descriptors.map((descriptor) => descriptor.name)).toEqual([
                'boot-probe'
            ]);

            const response = await fetch(`${listener.url}/v1/harness/harnesses`);
            const index = (await response.json()) as { items: { name: string }[] };

            expect(index.items.map((item) => item.name)).toEqual(['boot-team']);
        } finally {
            await listener.close();
        }
    });
});

describe('R-boot 4 — advanced injections and refusals', () => {
    it('keeps an injected registry/catalogue valid with an explicit plugin set', () => {
        const preset: HarnessPreset = {
            name: 'injected',
            title: 'Injected',
            description: 'A hand-built scripted preset.',
            requiresEndpoint: false,
            entry: 'injected',
            ranks: { injected: 'A' },
            agents: ['injected'],
            tools: [],
            builtin: false,
            editable: true,
            create: () =>
                createToolboxHarness(
                    {
                        agents: {
                            injected: agent({
                                model: SETTINGS.model,
                                instruction: 'Injected agent.',
                                stream: async function* () {
                                    yield { type: 'done', stopReason: 'stop' as const, toolCalls: [] };
                                }
                            })
                        },
                        entry: 'injected',
                        ranks: { injected: 'A' },
                        sharedToolbox: false
                    },
                    SETTINGS,
                    progress
                )
        };

        const runtime = createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            registry: createHarnessRegistry([preset]),
            // A registry is authoritative for the CATALOGUE; plugins are a per-build fact.
            harness: { plugins: [] }
        });

        expect(runtime.registry.list().map((entry) => entry.name)).toEqual(['injected']);
        // An explicit empty plugin list means ZERO executable plugins AND zero rows.
        expect(runtime.store.pluginSettings.descriptors).toEqual([]);
    });

    it('refuses a registry and presets together, and a store beside a harness configuration', () => {
        const registry = createHarnessRegistry([]);

        expect(() =>
            createHarnessRuntime({
                loadEnvironment: false,
                registry,
                harness: explicitConfiguration()
            })
        ).toThrow(/either an injected registry or `harness\.presets`, not both/);

        expect(() =>
            createHarnessRuntime({
                loadEnvironment: false,
                store: createBareRuntime().store,
                harness: { plugins: [] }
            })
        ).toThrow(/either an injected store or a `harness` boot configuration, not both/);
    });

    it('rejects a malformed declaration at the resolver, before anything is constructed', () => {
        expect(() => resolveHarnessBootConfiguration({ presets: [{ name: 'x', agents: [] }] } as never)).toThrow(
            /presets\[0\] \("x"\) is invalid: `agents` must name at least one agent/
        );
        expect(() =>
            resolveHarnessBootConfiguration({ presets: [{ name: 'x', agents: ['not-a-profile'] }] } as never)
        ).toThrow(/names unknown agent "not-a-profile"/);
        expect(() => resolveHarnessBootConfiguration({ toolbox: { maxIterations: -1 } } as never)).toThrow(
            /toolbox\.maxIterations must be a positive safe integer or Infinity/
        );
        expect(() => resolveHarnessBootConfiguration({ plugins: {} } as never)).toThrow(
            /plugins must be an array of plugin entries/
        );
    });
});

describe('R-boot — configuration signature', () => {
    it('is stable for structurally equal configurations and sensitive to executable changes', () => {
        expect(harnessBootSignature(undefined)).toBe(harnessBootSignature({}));
        expect(harnessBootSignature(explicitConfiguration())).toBe(harnessBootSignature(explicitConfiguration()));
        expect(harnessBootSignature(explicitConfiguration())).not.toBe(
            harnessBootSignature({
                ...explicitConfiguration(),
                presets: [
                    {
                        name: 'boot-team',
                        title: 'Boot team',
                        description: 'A boot-declared roster.',
                        agents: ['instruct'],
                        entry: 'instruct',
                        ranks: { instruct: 'A' },
                        tools: ['probeTool'],
                        environmentTools: []
                    }
                ]
            })
        );

        // A different factory closure is a different statement; the id is the only honest
        // equality a function has.
        const first = {
            presets: [
                {
                    name: 'factory',
                    agents: ['instruct'],
                    create: (() => undefined) as never
                }
            ]
        } satisfies HarnessBootConfiguration;
        const second = {
            presets: [
                {
                    name: 'factory',
                    agents: ['instruct'],
                    create: (() => undefined) as never
                }
            ]
        } satisfies HarnessBootConfiguration;

        expect(harnessBootSignature(first)).toBe(harnessBootSignature(first));
        expect(harnessBootSignature(first)).not.toBe(harnessBootSignature(second));
    });
});

// ---------------------------------------------------------------------------
// B1 — THE EFFECTIVE PER-CARD POSTURE (and what an advanced factory may claim)
// ---------------------------------------------------------------------------
// The probes behind this block: a card's toolbox lives in its CLOSURE, so a host that
// passes the shipped `HarnessPreset[]` through `harness.presets` could only be understood
// from its declaration. The old compiler merged the deployment floor UNDER every card, so
// the tool-less `chat` card inherited `sharedToolbox: true` and both environment rows,
// registered them, advertised them, and then re-recorded them into a frozen session. These
// cases pin the corrected resolution: a stated tool list with no shared name is a tool-less
// card; an advanced `create` claims exactly what the host stated (never the floor).
describe('R-boot 5 — B1: per-card posture and advanced declarations', () => {
    it('keeps the shipped chat card tool-less under a shared deployment floor', () => {
        const boot = resolveHarnessBootConfiguration({
            presets,
            toolbox: { sharedToolbox: true }
        });

        const chat = boot.presets.find((preset) => preset.name === 'chat')!;
        const general = boot.presets.find((preset) => preset.name === 'general')!;

        expect(chat.tools).toEqual([]);
        expect(chat.environmentTools).toBeUndefined();
        expect(chat.creation).toEqual({
            factory: 'profiled',
            toolbox: { sharedToolbox: false, websearch: false, webfetch: false }
        });

        const chatTools = Object.keys(chat.create(SETTINGS, progress).tools);

        expect(chatTools).not.toContain('read');
        expect(chatTools).not.toContain(WEB_SEARCH_TOOL_NAME);
        expect(chatTools).not.toContain(WEB_FETCH_TOOL_NAME);

        // The seven real cards keep the shared set AND both rows they declare.
        expect(general.tools).toEqual([...SHARED_TOOL_NAMES]);
        expect(general.environmentTools).toEqual([WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME]);
        expect(general.creation).toEqual({
            factory: 'profiled',
            toolbox: { sharedToolbox: true, websearch: true, webfetch: true }
        });
        expect(Object.keys(general.create(SETTINGS, progress).tools)).toContain('read');
    });

    it('an advanced factory declares only what the host stated', () => {
        const preset = resolveHarnessBootConfiguration({
            presets: [
                {
                    name: 'opaque',
                    agents: ['general'],
                    // A closure nothing at this seam may inspect.
                    create: () =>
                        createToolboxHarness(
                            {
                                agents: agentsFromProfiles(['general'], SETTINGS),
                                entry: 'general',
                                ranks: { general: 'A' },
                                sharedToolbox: false
                            },
                            SETTINGS,
                            progress
                        )
                }
            ],
            // A deployment that turns EVERYTHING on. None of it may be projected onto a
            // factory the host supplied, because this seam cannot know what it registers.
            toolbox: {
                sharedToolbox: true,
                websearch: true,
                webfetch: true,
                extraTools: { probeTool }
            }
        }).presets[0];

        expect(preset.tools).toEqual([]);
        expect(preset.environmentTools).toBeUndefined();
        expect(preset.template).toBeUndefined();
        expect(preset.creation).toEqual({ factory: 'advanced' });

        const tools = Object.keys(preset.create(SETTINGS, progress).tools);

        expect(tools).not.toContain('read');
        expect(tools).not.toContain(WEB_SEARCH_TOOL_NAME);
        expect(tools).not.toContain(WEB_FETCH_TOOL_NAME);
        expect(tools).not.toContain('probeTool');
    });

    it('an advanced factory keeps the declarations the host did state', () => {
        const preset = resolveHarnessBootConfiguration({
            presets: [
                {
                    name: 'declared',
                    agents: ['general'],
                    tools: ['probeTool'],
                    environmentTools: [WEB_FETCH_TOOL_NAME],
                    create: () =>
                        createToolboxHarness(
                            {
                                agents: agentsFromProfiles(['general'], SETTINGS),
                                entry: 'general',
                                ranks: { general: 'A' },
                                sharedToolbox: false
                            },
                            SETTINGS,
                            progress
                        )
                }
            ],
            toolbox: { sharedToolbox: false }
        }).presets[0];

        expect(preset.tools).toEqual(['probeTool']);
        expect(preset.environmentTools).toEqual([WEB_FETCH_TOOL_NAME]);
    });
});

// ---------------------------------------------------------------------------
// B2 — RESOLUTION IS PURE; VALIDATION USES THE EFFECTIVE CATALOGUE
// ---------------------------------------------------------------------------
describe('R-boot 6 — B2: no process-global agent effect, effective validation', () => {
    it('does not replace the process agent layer while compiling presets', () => {
        // A live server registry owns the process layer; the operator edited a profile.
        const state = createAgentState();

        attachDefaultAgentState(state);

        const registry = createHarnessRegistry([], { agentState: state });

        state.patch('instruct', { instruction: 'Operator instruction' });

        expect(defaultAgentState()).toBe(state);
        expect(effectiveAgentProfile('instruct')?.instruction).toBe('Operator instruction');

        // Resolution used to build a scratch registry WITHOUT this option, and that
        // registry installed its own EMPTY layer as the process default: the operator's
        // edit vanished from every future session build.
        resolveHarnessBootConfiguration({
            presets: [{ name: 'boot', agents: ['instruct'] }]
        });

        expect(defaultAgentState()).toBe(state);
        expect(effectiveAgentProfile('instruct')?.instruction).toBe('Operator instruction');
        expect(
            registry.agents().find((profile) => profile.name === 'instruct')?.instruction
        ).toBe('Operator instruction');

        attachDefaultAgentState(createAgentState());
    });

    it('validates a roster against the registry own effective catalogue', () => {
        // A catalogue source that does NOT contain `general`. The frozen module array does,
        // so a validation that bypassed the registry's own layer would accept it.
        const catalogue = agentProfiles().filter((profile) => profile.name !== 'general');
        const state = createAgentState([], () => catalogue);
        const registry = createHarnessRegistry([], { agentState: state });

        expect(registry.agentState()).toBe(state);
        expect(registry.agents().map((profile) => profile.name)).not.toContain('general');
        expect(() => registry.create({ name: 'no-general', agents: ['general'] })).toThrow(
            /`agents` names unknown agent "general"/
        );
        expect(registry.create({ name: 'known', agents: ['instruct'] }).agents).toEqual(['instruct']);

        attachDefaultAgentState(createAgentState());
    });
});

// ---------------------------------------------------------------------------
// B4 — PER-CARD REBUILD METADATA (update, record replay, frozen restore)
// ---------------------------------------------------------------------------
// The deployment below is DELIBERATELY wide (shared toolbox on, both rows on, its own
// extra tool). The card is tool-less and carries its own extra tool, so every assertion
// distinguishes "rebuilt the card" from "fell back to the deployment default".
const deploymentTool = tool<Record<string, never>, { deployment: true }>({
    description: 'Deployment-wide tool.',
    tags: ['boot', 'deployment'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ deployment: true })
});

const perCardConfiguration = (): HarnessBootConfiguration => ({
    presets: [
        {
            name: 'card',
            title: 'Card',
            description: 'A per-card posture.',
            agents: ['general'],
            entry: 'general',
            ranks: { general: 'A' },
            // A stated list with no shared name states a tool-less card (B1)…
            tools: ['probeTool'],
            // …and an explicit empty row list clears the deployment's both rows.
            environmentTools: [],
            // The card's own definition map REPLACES the deployment's.
            extraTools: { probeTool }
        }
    ],
    toolbox: {
        sharedToolbox: true,
        websearch: true,
        webfetch: true,
        extraTools: { deploymentTool }
    }
});

const createRuntimeAt = (root: string, configuration: HarnessBootConfiguration) =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        loadEnvironment: false,
        harness: configuration
    });

// The tool names a factory really registers. Sorted so a test compares sets, not order.
const registeredTools = (preset: HarnessPreset): string[] =>
    Object.keys(preset.create(SETTINGS, progress).tools).sort();

describe('R-boot 7 — B4: executable updates rebuild the card, not the deployment', () => {
    it('keeps the per-card extra tool and empty row list across title and agent updates', () => {
        const boot = resolveHarnessBootConfiguration(perCardConfiguration());
        const registry = createHarnessRegistry(boot.presets, { creation: boot.toolbox });

        registry.update('card', { title: 'Renamed' });

        const afterTitle = registry.find('card')!;

        expect(afterTitle.title).toBe('Renamed');
        expect(afterTitle.tools).toEqual(['probeTool']);
        expect(registeredTools(afterTitle)).toContain('probeTool');
        expect(registeredTools(afterTitle)).not.toContain('deploymentTool');
        expect(registeredTools(afterTitle)).not.toContain('read');

        // An EXECUTABLE edit: roster + ranks + entry, rebuilt from the card's own posture.
        registry.update('card', {
            agents: ['instruct', 'general'],
            entry: 'instruct',
            ranks: { instruct: 'A', general: 'B' }
        });

        const afterAgents = registry.find('card')!;
        const tools = registeredTools(afterAgents);

        expect(afterAgents.agents).toEqual(['instruct', 'general']);
        expect(afterAgents.tools).toEqual(['probeTool']);
        expect(tools).toContain('probeTool');
        expect(tools).not.toContain('deploymentTool');
        expect(tools).not.toContain('read');
        expect(tools).not.toContain(WEB_SEARCH_TOOL_NAME);
        expect(tools).not.toContain(WEB_FETCH_TOOL_NAME);
    });

    it('a prose-only saved row replays without widening the card', async () => {
        const root = await scratchRoot('boot-b4-prose-');
        const configuration = perCardConfiguration();
        const first = createRuntimeAt(root, configuration);

        await first.store.mutateRegistry(() => first.registry.update('card', { title: 'Operator title' }));
        first.store.dispose();

        const second = createRuntimeAt(root, configuration);
        const preset = second.registry.find('card')!;

        expect(preset.title).toBe('Operator title');
        expect(preset.tools).toEqual(['probeTool']);
        expect(registeredTools(preset)).toContain('probeTool');
        expect(registeredTools(preset)).not.toContain('deploymentTool');
        expect(registeredTools(preset)).not.toContain('read');

        second.store.dispose();
    });

    it('an executable saved row replays on the card own posture', async () => {
        const root = await scratchRoot('boot-b4-exec-');
        const configuration = perCardConfiguration();
        const first = createRuntimeAt(root, configuration);

        await first.store.mutateRegistry(() =>
            first.registry.update('card', {
                agents: ['instruct', 'general'],
                entry: 'instruct',
                ranks: { instruct: 'A', general: 'B' }
            })
        );
        first.store.dispose();

        const second = createRuntimeAt(root, configuration);
        const preset = second.registry.find('card')!;
        const tools = registeredTools(preset);

        expect(preset.agents).toEqual(['instruct', 'general']);
        expect(preset.entry).toBe('instruct');
        expect(tools).toContain('probeTool');
        expect(tools).not.toContain('deploymentTool');
        expect(tools).not.toContain('read');
        expect(tools).not.toContain(WEB_FETCH_TOOL_NAME);

        second.store.dispose();
    });

    it('a frozen session restores on the card posture, not the deployment default', async () => {
        const root = await scratchRoot('boot-b4-frozen-');
        const configuration = perCardConfiguration();
        const first = createRuntimeAt(root, configuration);
        const created = await first.store.create('card');
        const id = created.id;
        const before = Object.keys(first.store.peekSession(id)!.harness.tools).sort();

        expect(before).toContain('probeTool');
        expect(before).not.toContain('read');

        // Make the registry entry disagree with the session's frozen record, so the
        // restore MUST take the `presetFromRecord` path.
        await first.store.mutateRegistry(() =>
            first.registry.update('card', {
                agents: ['instruct', 'general'],
                entry: 'instruct',
                ranks: { instruct: 'A', general: 'B' }
            })
        );
        first.store.dispose();

        const second = createRuntimeAt(root, configuration);
        const restored = second.store.peekSession(id)!;
        const after = Object.keys(restored.harness.tools).sort();

        expect(after).toEqual(before);
        expect(after).toContain('probeTool');
        expect(after).not.toContain('deploymentTool');
        expect(after).not.toContain('read');
        expect(restored.preset.creation).toEqual({
            factory: 'profiled',
            toolbox: expect.objectContaining({
                sharedToolbox: false,
                websearch: false,
                webfetch: false,
                extraTools: expect.objectContaining({ probeTool })
            })
        });

        second.store.dispose();
    });

    it('a production-composed chat session stays tool-less across a restart', async () => {
        const root = await scratchRoot('boot-b1-chat-');
        const configuration: HarnessBootConfiguration = {
            presets,
            toolbox: { sharedToolbox: true }
        };

        const first = createRuntimeAt(root, configuration);
        const created = await first.store.create('chat');
        const id = created.id;
        const before = Object.keys(first.store.peekSession(id)!.harness.tools).sort();

        expect(before).not.toContain('read');
        expect(before).not.toContain(WEB_SEARCH_TOOL_NAME);
        expect(before).not.toContain(WEB_FETCH_TOOL_NAME);
        first.store.dispose();

        // Same boot configuration re-injected: the frozen record is replayed onto the
        // recompiled card, which must still be the tool-less one (the probe's regression:
        // the record used to carry `search`/`fetch` and the restore re-registered them).
        const second = createRuntimeAt(root, configuration);
        const restored = second.store.peekSession(id)!;

        expect(Object.keys(restored.harness.tools).sort()).toEqual(before);
        expect(Object.keys(restored.harness.tools)).not.toContain(WEB_FETCH_TOOL_NAME);
        expect(restored.preset.tools).toEqual([]);
        expect(restored.preset.environmentTools).toBeUndefined();

        second.store.dispose();
    });

    it('an advanced factory refuses an executable update and keeps a metadata-only one', () => {
        const boot = resolveHarnessBootConfiguration({
            presets: [
                {
                    name: 'advanced-card',
                    title: 'Advanced',
                    description: 'A host factory.',
                    agents: ['general'],
                    create: () =>
                        createToolboxHarness(
                            {
                                agents: agentsFromProfiles(['general'], SETTINGS),
                                entry: 'general',
                                ranks: { general: 'A' },
                                sharedToolbox: false,
                                extraTools: { probeTool }
                            },
                            SETTINGS,
                            progress
                        )
                }
            ],
            toolbox: { sharedToolbox: true }
        });
        const registry = createHarnessRegistry(boot.presets, { creation: boot.toolbox });

        expect(() => registry.update('advanced-card', { agents: ['instruct'] })).toThrow(
            /was configured with a custom `create` factory, which the registry cannot rebuild/
        );
        // The refusal did not mutate the entry.
        expect(registry.find('advanced-card')!.agents).toEqual(['general']);

        registry.update('advanced-card', { title: 'Renamed' });

        const preset = registry.find('advanced-card')!;

        expect(preset.title).toBe('Renamed');
        expect(preset.creation).toEqual({ factory: 'advanced' });
        expect(Object.keys(preset.create(SETTINGS, progress).tools)).toContain('probeTool');
    });

    it('a frozen advanced-factory session restores the host factory, never a profiled substitute', async () => {
        const root = await scratchRoot('boot-b4-advanced-');
        const configuration: HarnessBootConfiguration = {
            presets: [
                {
                    name: 'advanced-card',
                    title: 'Advanced',
                    description: 'A host factory.',
                    agents: ['general'],
                    create: () =>
                        createToolboxHarness(
                            {
                                agents: agentsFromProfiles(['general'], SETTINGS),
                                entry: 'general',
                                ranks: { general: 'A' },
                                sharedToolbox: false,
                                extraTools: { probeTool }
                            },
                            SETTINGS,
                            progress
                        )
                }
            ],
            toolbox: { sharedToolbox: true }
        };

        const first = createRuntimeAt(root, configuration);
        const created = await first.store.create('advanced-card');
        const id = created.id;

        expect(Object.keys(first.store.peekSession(id)!.harness.tools)).toContain('probeTool');

        // Force the record to differ from the live entry (a metadata-only edit keeps the
        // factory), so restore goes through `presetFromRecord`'s injected/advanced branch.
        await first.store.mutateRegistry(() =>
            first.registry.update('advanced-card', { title: 'Renamed' })
        );
        first.store.dispose();

        const second = createRuntimeAt(root, configuration);
        const restored = second.store.peekSession(id)!;

        expect(restored.preset.template).toBeUndefined();
        expect(restored.preset.creation).toEqual({ factory: 'advanced' });
        expect(Object.keys(restored.harness.tools)).toContain('probeTool');
        expect(Object.keys(restored.harness.tools)).not.toContain('read');

        second.store.dispose();
    });
});

// ---------------------------------------------------------------------------
// B5 — THE INJECTED-REGISTRY + BOOT TOOLBOX CONTRACT
// ---------------------------------------------------------------------------
describe('R-boot 8 — B5: a stated boot toolbox is refused beside an injected registry', () => {
    const injectedRegistry = () =>
        createHarnessRegistry([], {
            creation: { sharedToolbox: false }
        });

    it('refuses `harness.toolbox` on a direct runtime and accepts the registry alone', () => {
        expect(() =>
            createHarnessRuntime({
                loadEnvironment: false,
                registry: injectedRegistry(),
                harness: { toolbox: { sharedToolbox: false } }
            })
        ).toThrow(
            /cannot apply `harness\.toolbox` to an injected registry: an injected registry owns its creation defaults/
        );

        // The contract every existing caller uses stays valid: registry, no toolbox.
        const runtime = createHarnessRuntime({
            loadEnvironment: false,
            registry: injectedRegistry(),
            harness: { plugins: [] }
        });

        expect(runtime.registry.list()).toEqual([]);
        expect(runtime.registry.creationDefaults()).toEqual({ sharedToolbox: false });
    });

    it('refuses it on the standalone listener too', async () => {
        await expect(
            startHarnessServer({
                port: 0,
                staticRoot: null,
                registry: injectedRegistry(),
                harness: { toolbox: {} }
            })
        ).rejects.toThrow(
            /cannot apply `harness\.toolbox` to an injected registry: an injected registry owns its creation defaults/
        );
    });
});

// ---------------------------------------------------------------------------
// B7 — THE CACHE SIGNATURE COMPARES NORMALIZED SEMANTICS
// ---------------------------------------------------------------------------
describe('R-boot 9 — B7: equivalent configurations share one signature', () => {
    it('treats every zero-floor spelling as one configuration', () => {
        const zeroFloor: HarnessBootConfiguration[] = [
            {},
            { presets: [] },
            { plugins: [] },
            { commands: [] },
            { toolbox: {} },
            { toolbox: { sharedToolbox: false } },
            {
                toolbox: {
                    sharedToolbox: false,
                    websearch: false,
                    webfetch: false
                }
            },
            { presets: [], plugins: [], commands: [], toolbox: { sharedToolbox: false } }
        ];

        const signatures = new Set([
            harnessBootSignature(undefined),
            ...zeroFloor.map((configuration) => harnessBootSignature(configuration))
        ]);

        expect(signatures.size).toBe(1);
    });

    it('keeps behaviourally different configurations distinct', () => {
        const zero = harnessBootSignature(undefined);

        expect(harnessBootSignature({ toolbox: { sharedToolbox: true } })).not.toBe(zero);
        expect(harnessBootSignature({ toolbox: { websearch: true } })).not.toBe(zero);
        expect(harnessBootSignature({ toolbox: { extraTools: { probeTool } } })).not.toBe(zero);
        expect(
            harnessBootSignature({ presets: [{ name: 'a', agents: ['general'] }] })
        ).not.toBe(zero);
        expect(harnessBootSignature({ plugins: [probePlugin] })).not.toBe(zero);

        // `Infinity` is a real budget and must not be confused with an absent one or a
        // finite number (JSON.stringify alone would turn it into `null`).
        const infinite = harnessBootSignature({ toolbox: { maxIterations: Infinity } });

        expect(infinite).not.toBe(zero);
        expect(infinite).not.toBe(harnessBootSignature({ toolbox: { maxIterations: 5 } }));
    });

    it('agrees between an equivalent row list and boolean, and ignores key order', () => {
        expect(
            harnessBootSignature({
                presets: [
                    { name: 'a', agents: ['general'], sharedToolbox: false, websearch: true }
                ]
            })
        ).toBe(
            harnessBootSignature({
                presets: [
                    {
                        name: 'a',
                        agents: ['general'],
                        sharedToolbox: false,
                        environmentTools: [WEB_SEARCH_TOOL_NAME]
                    }
                ]
            })
        );

        expect(
            harnessBootSignature({
                toolbox: { extraToolSources: { read: 'a/read.ts', grep: 'a/grep.ts' } }
            })
        ).toBe(
            harnessBootSignature({
                toolbox: { extraToolSources: { grep: 'a/grep.ts', read: 'a/read.ts' } }
            })
        );
    });

    it('lets a service warm-up and a zero-spelled first request share one runtime', async () => {
        const root = await scratchRoot('boot-b7-cache-');

        try {
            const viaWarmup = getHarnessRuntime({
                root,
                loadEnvironment: false,
                harness: { presets: [], toolbox: { sharedToolbox: false } }
            });
            const viaRequest = getHarnessRuntime({ root, loadEnvironment: false, harness: {} });

            expect(viaRequest).toBe(viaWarmup);

            // A genuinely different posture is still a loud conflict.
            expect(() =>
                getHarnessRuntime({
                    root,
                    loadEnvironment: false,
                    harness: { toolbox: { sharedToolbox: true } }
                })
            ).toThrow(/already created with a DIFFERENT boot configuration/);
        } finally {
            setHarnessRuntime(undefined, root);
        }
    });
});

// ---------------------------------------------------------------------------
// B8 — EXTRA TOOLS/SOURCES ARE PART OF THE CARD (never invisible by construction)
// ---------------------------------------------------------------------------
describe('R-boot 10 — B8: extra registrations appear on the card', () => {
    it('derives the declaration from the card own extra tools and sources', () => {
        const preset = resolveHarnessBootConfiguration({
            presets: [{ name: 'extra-card', agents: ['general'], sharedToolbox: false }],
            toolbox: {
                sharedToolbox: false,
                extraToolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow },
                extraTools: { probeTool }
            }
        }).presets[0];

        // Sources first (map order), then constructed definitions, deduplicated.
        expect(preset.tools).toEqual(['timeNow', 'probeTool']);
        expect(describeHarness(preset).tools).toEqual(['timeNow', 'probeTool']);

        const harness = preset.create(SETTINGS, progress);

        expect(Object.keys(harness.tools)).toContain('timeNow');
        expect(Object.keys(harness.tools)).toContain('probeTool');
    });

    it('a registry-created card declares the registry extra tools it will register', () => {
        const registry = createHarnessRegistry([], {
            creation: { sharedToolbox: false, extraTools: { probeTool } }
        });
        const created = registry.create({ name: 'created-card', agents: ['general'] });

        expect(created.tools).toEqual(['probeTool']);
        expect(Object.keys(created.create(SETTINGS, progress).tools)).toContain('probeTool');
    });
});

// ---------------------------------------------------------------------------
// ZERO-DEFAULT DIRECT-CALL CATALOGUE (the bare boot exposes no optional row)
// ---------------------------------------------------------------------------
describe('R-boot 11 — an omitted direct-call catalogue is EMPTY', () => {
    it('a bare runtime serves no direct-call row and lists exactly the core set', async () => {
        const runtime = createBareRuntime();
        const coreNames = createCoreToolEntries().map((entry) => entry.name);

        expect(runtime.catalogue.entries).toEqual([]);
        expect(runtime.catalogue.tools).toEqual({});

        const listed = await runtime.api({
            method: 'GET',
            pathname: '/v1/harness/tools',
            mount: '/v1/harness',
            readBody: async () => ({})
        });

        expect(listed.kind).toBe('json');
        expect(listed.status).toBe(200);
        expect(
            (listed as { body: { items: { name: string }[] } }).body.items.map((item) => item.name)
        ).toEqual(coreNames);
    });

    it('a bare listener exposes no package/app/web row over HTTP', async () => {
        const listener = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            const response = await fetch(`${listener.url}/v1/harness/tools`);
            const body = (await response.json()) as { items: { name: string }[] };
            const names = body.items.map((item) => item.name);

            expect(response.status).toBe(200);
            expect(names).toEqual(createCoreToolEntries().map((entry) => entry.name));

            for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'timeNow', 'textCount', WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME]) {
                expect(names).not.toContain(name);
            }
        } finally {
            await listener.close();
        }
    });

    it('an explicit catalogue is still served verbatim', async () => {
        const runtime = createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            catalogue: createToolCatalogue()
        });
        const names = runtime.catalogue.entries.map((entry) => entry.name);

        expect(names).toContain('read');
        expect(names).toContain('timeNow');
        expect(names).toContain(WEB_SEARCH_TOOL_NAME);
        expect(names).toContain(WEB_FETCH_TOOL_NAME);

        const listed = await runtime.api({
            method: 'GET',
            pathname: '/v1/harness/tools',
            mount: '/v1/harness',
            readBody: async () => ({})
        });

        expect(
            (listed as { body: { items: { name: string }[] } }).body.items.map((item) => item.name)
        ).toContain('read');
    });

    it('the service seam keeps the zero catalogue for an unconfigured root', async () => {
        const root = await scratchRoot('boot-zero-service-');

        try {
            const listed = await handlerCall({ root }, 'GET', '/v1/harness/tools');

            expect(listed.status).toBe(200);
            expect((listed.body.items as { name: string }[]).map((item) => item.name)).toEqual(
                createCoreToolEntries().map((entry) => entry.name)
            );
        } finally {
            setHarnessRuntime(undefined, root);
        }
    });
});
