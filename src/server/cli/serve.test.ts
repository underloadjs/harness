// `--serve` boot regression (R-boot): the first-party CLI is a HOST and must keep
// serving the shipped production catalogue, plugins, shared toolbox and direct-call
// catalogue now that `startHarnessServer` treats every omitted member as the zero floor.
//
// `cli/index.ts` runs `main()` at import time, so these tests pin the options builder
// in ./serve.ts — the exact object the `--serve` branch hands `startHarnessServer` —
// without binding a socket or calling a provider.
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, createToolCatalogue, presets, resolveHarnessBootConfiguration } from '../index';
import { CLI_HARNESS_BOOT_CONFIGURATION, createCliServeOptions } from './serve';

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'test-key',
    model: 'test/model'
};

describe('CLI --serve options', () => {
    it('states the shipped presets, built-in plugins and shared toolbox explicitly', () => {
        const options = createCliServeOptions({ port: 0, host: '127.0.0.1', settings: SETTINGS });

        // Identity first: the builder must hand over the one declared production
        // configuration, not a freshly assembled lookalike.
        expect(options.harness).toBe(CLI_HARNESS_BOOT_CONFIGURATION);
        expect(options.harness).toEqual({
            presets,
            plugins: BUILTIN_PLUGINS,
            toolbox: { sharedToolbox: true }
        });

        // Resolve it with the SAME function the server boot uses. This is the provisioning
        // proof: names are the shipped ones, and the executable factories are the shipped
        // factories (so each card keeps its own captured toolbox posture).
        const boot = resolveHarnessBootConfiguration(options.harness);

        expect(boot.presets.map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(boot.presets.map((preset) => preset.create)).toEqual(
            presets.map((preset) => preset.create)
        );
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
        expect(boot.toolbox).toEqual({ sharedToolbox: true });
    });

    it('passes the shipped direct-call catalogue explicitly and builds it per call', () => {
        const options = createCliServeOptions({ settings: SETTINGS });

        // Bare boot no longer supplies the direct-call catalogue, so `GET /tools` and
        // `POST /tools/{name}` would otherwise serve the core-only floor.
        expect(options.catalogue?.entries.map((entry) => entry.name)).toEqual([
            'syntax',
            'read',
            'write',
            'edit',
            'files',
            'glob',
            'grep',
            'shell',
            'gitDiff',
            'download',
            'timeNow',
            'textCount',
            'diceRoll',
            'noteSearch',
            'textSummarize',
            'search',
            'fetch'
        ]);

        // Per options build (never a module-level snapshot): `./index.ts` loads `.env`
        // before `main()`, and the environment-backed `search` entry must see that.
        const again = createCliServeOptions({ settings: SETTINGS });

        expect(again.catalogue).not.toBe(options.catalogue);
        expect(again.catalogue?.entries.map((entry) => entry.name)).toEqual(
            createToolCatalogue().entries.map((entry) => entry.name)
        );
    });

    it('forwards port, host, settings and the advertised defaults verbatim', () => {
        const options = createCliServeOptions({ port: 0, host: '0.0.0.0', settings: SETTINGS });

        expect(options.port).toBe(0);
        expect(options.host).toBe('0.0.0.0');
        expect(options.settings).toBe(SETTINGS);
        expect(options.defaults).toEqual({
            baseURL: 'http://provider.test/v1',
            model: 'test/model',
            hasApiKey: true
        });

        // No `--port`/`--host` stays omitted (the server applies its own defaults), and a
        // blank key is advertised as absent — the value is an advertisement, never the key.
        const omitted = createCliServeOptions({ settings: { ...SETTINGS, apiKey: '   ' } });

        expect(omitted.port).toBeUndefined();
        expect(omitted.host).toBeUndefined();
        expect(omitted.defaults).toEqual({
            baseURL: 'http://provider.test/v1',
            model: 'test/model',
            hasApiKey: false
        });
    });
});
