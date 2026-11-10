// CLI preset default + "no endpoint-free preset is left" (the roster pass + the
// fixture deletion).
//
// `index.ts` is executable at import time, so the parser lives in ./options and
// these assertions pin the product decision without booting a process:
//   - no `--preset` selects the LIVE General role (the default card the catalogue
//     lists first), never a silent fallback to something cheaper;
//   - every preset the CLI can select needs a provider, because the scripted `demo`
//     fixture that used to be the endpoint-free escape hatch is deleted. `--preset demo`
//     is now an unknown name, and ./index.ts says so and lists what does exist.

import { describe, expect, it } from 'vitest';
import { findPreset, presets } from '../harnesses';
import { DEFAULT_CLI_PRESET, parseCliOptions } from './options';

describe('CLI preset selection', () => {
    it('defaults to the live General role instead of the demo', () => {
        const parsed = parseCliOptions([]);

        // The CLI agrees with the catalogue: `general` is presets[0] and the card the
        // UI selects first (../harnesses/presets.ts:486-494), so `DEFAULT_CLI_PRESET`
        // in ./options.ts:24 names it — `instruct` is one flag away, not the entry.
        expect(DEFAULT_CLI_PRESET).toBe('general');
        expect(parsed.values.preset).toBe('general');
        expect(parsed.positionals).toEqual([]);

        const preset = findPreset(parsed.values.preset as string);

        expect(preset).toBeDefined();
        expect({
            name: preset!.name,
            title: preset!.title,
            primary: preset!.primary,
            requiresEndpoint: preset!.requiresEndpoint,
            subagents: preset!.subagents
        }).toEqual({
            name: 'general',
            title: 'General',
            primary: 'general',
            requiresEndpoint: true,
            // Load-bearing, not an omission: the default card has no team, so the
            // runtime never registers `delegate` for it (src/harness.ts
            // `activation: 'subagents'`). A non-empty team here is a product change.
            subagents: []
        });
    });

    it('offers no endpoint-free preset: the scripted demo is gone', () => {
        const parsed = parseCliOptions(['--preset', 'demo', 'what time is it']);

        // The parser still accepts the flag (it takes a name, it does not validate it),
        // but the catalogue has no such row, so ./index.ts takes its
        // `unknown harness preset` branch and prints the real list instead of silently
        // running a script.
        expect(parsed.values.preset).toBe('demo');
        expect(parsed.positionals).toEqual(['what time is it']);
        expect(findPreset(parsed.values.preset as string)).toBeUndefined();
        expect(findPreset('flaky')).toBeUndefined();

        // The rule generalises: EVERY selectable preset is live, so the CLI's "needs a
        // provider base URL" check fires for all of them. A future card with
        // `requiresEndpoint: false` is a product decision and fails here.
        expect(presets.filter((preset) => !preset.requiresEndpoint).map((preset) => preset.name)).toEqual([]);

        // What the CLI's check really protects against: a live role needs BOTH a model and a
        // transport at CONSTRUCTION, and each throws its own message first — the model check
        // (src/core/agent.ts:419) runs before the transport check (src/core/agent.ts:153), and
        // the toolbox preset builds its agents through `agentFromProfile`
        // (../harnesses/toolbox.ts:327), so an empty BASE URL is not legal even before a
        // request. The `needs a provider base URL` message in ./index.ts is the courtesy that
        // names the missing setting instead of surfacing a HarnessError from the core.
        expect(() =>
            findPreset('general')!.create({ baseURL: '', apiKey: '', model: '' }, () => {})
        ).toThrow('An agent requires a model.');
        expect(() =>
            findPreset('general')!.create({ baseURL: '', apiKey: '', model: 'test/model' }, () => {})
        ).toThrow('Agent "general" has no transport: provide either `stream` or `provider.baseURL`.');

        const live = findPreset('general')!.create(
            { baseURL: 'http://provider.test/v1', apiKey: '', model: 'test/model' },
            () => {}
        );

        expect(live.tools.delegate).toBeUndefined();
        expect(Object.keys(live.tools).length).toBeGreaterThan(10);
    });

    it('still accepts the short -p form and leaves other options at their defaults', () => {
        const parsed = parseCliOptions(['-p', 'reviewer', 'review this']);

        expect(parsed.values).toMatchObject({
            preset: 'reviewer',
            list: false,
            tools: false,
            json: false,
            serve: false,
            help: false
        });
        expect(parsed.positionals).toEqual(['review this']);
    });
});
