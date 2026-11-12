// T5 (R2/R3) — the server's plugin settings store: defaults, validation, persistence shape,
// and the LIVE provider the whole feature rests on.
//
// WHAT THIS FILE PROVES (one block per acceptance criterion):
//   1. DEFAULTS      — an untouched runtime stores NOTHING: `get` is `undefined` (the harness
//                      applies the plugin's own declared default) while `values()` reports that
//                      default, so the UI and the plugin agree.
//   2. VALIDATION    — every descriptor rule at the write edge: type, `min`/`max`, unknown key,
//                      unknown plugin, empty patch, and the documented decision that `step` is
//                      an editor hint rather than a refusal.
//   3. NORMALIZATION — a numeric/boolean STRING form is accepted (a query parameter or a JSON
//                      document is where these values legitimately come from) and stored as the
//                      declared type, so a document always holds JSON scalars.
//   4. RESET         — `null` clears one override and the declared default applies again.
//   5. LIVE PROVIDER — the provider object a harness captured at construction returns the NEW
//                      value after `update`, with no rebuild (the acceptance criterion behind
//                      "I can set a context limit size" reaching a running conversation).
//   6. PERSISTENCE   — `snapshot()` is overrides-only in catalogue order, and `restore()` puts
//                      it back, dropping what this build no longer declares instead of throwing.
//   7. SHIPPED CATALOGUE — the two real built-ins, their real bounds, and the real defaults.
//
// Determinism: every expected value below is exact (`toEqual`/`toBe`), no ranges, and the
// store's own revision counter is asserted as a literal per accepted write.
//
// Cross-references:
//   - ./plugins.ts                        — the module under test
//   - ../plugins/*.plugin.ts              — the metadata the shipped catalogue seeds from
//   - ../plugin/settings.ts               — the view `values()` and the provider read resolve through
//   - ../shared/harness-api.ts            — `PluginSetting`/`PluginSummary`, the wire spelling
import { describe, expect, it } from 'vitest';

import { BUILTIN_PLUGIN_DESCRIPTORS } from '../plugin/manifest';
import { createPluginSettingsView } from '../plugin/settings';
import type { HarnessPluginMetadata } from '../types';
import {
    HarnessPluginSettingsError,
    PLUGIN_ENABLED_KEY,
    createPluginSettingsStore,
    pluginSettingsProviderOf
} from './plugins';
import type { HarnessPluginSettingsRecord } from './persistence';

// A fixture catalogue with one plugin that declares every setting TYPE plus one plugin that
// declares nothing, which no shipped plugin is yet. Injected (rather than added to
// `src/plugins`) so the validation matrix is pinned without touching the scanned folder.
const FIXTURES: readonly HarnessPluginMetadata[] = [
    {
        name: 'alpha',
        title: 'Alpha',
        description: 'A plugin with one setting of every declared type.',
        version: '1.0.0',
        tags: ['fixture'],
        builtin: true,
        hooks: ['turn.before'],
        settings: [
            {
                key: 'limit',
                label: 'Limit',
                type: 'number',
                default: 100,
                min: 10,
                max: 1000,
                step: 10
            },
            { key: 'name', label: 'Name', type: 'string', default: 'seed' },
            { key: 'enabled', label: 'Enabled', type: 'boolean', default: false }
        ]
    },
    {
        // No settings, no hooks: still listed, because an operator has to see what is loaded.
        name: 'beta',
        title: 'Beta',
        builtin: true
    }
];

const store = () => createPluginSettingsStore({ descriptors: FIXTURES });

/** One rejected patch, as the message + status the route would answer. */
const failureOf = (run: () => unknown): { status: number; message: string } => {
    try {
        run();
    } catch (error) {
        if (error instanceof HarnessPluginSettingsError) return { status: error.status, message: error.message };

        throw error;
    }

    throw new Error('Expected the patch to be rejected; it was accepted.');
};

describe('plugin settings store — declared defaults', () => {
    it('stores nothing while the operator has changed nothing', () => {
        const plugins = store();

        // `get` is the provider's "nothing stored" signal, so the plugin's own default stays
        // owned by the plugin (./plugins.ts header).
        expect(plugins.get('alpha', 'limit')).toBeUndefined();
        expect(plugins.get('alpha', 'name')).toBeUndefined();
        expect(plugins.get('alpha', 'enabled')).toBeUndefined();

        // `values` is what the wire reports: the effective value of every declared key.
        expect(plugins.values('alpha')).toEqual({ limit: 100, name: 'seed', enabled: false });

        // A plugin that declares nothing has nothing to resolve.
        expect(plugins.values('beta')).toEqual({});
        expect(plugins.settingsOf('beta')).toEqual([]);

        // And so does an unknown plugin: `values` is a projection, never a 404 (the ROUTE
        // resolves identity; the store stays total so no read path can throw).
        expect(plugins.values('missing')).toEqual({});
        expect(plugins.snapshot()).toEqual({});
        expect(plugins.revision()).toBe(0);
    });

    it('keeps the manifest order as the stable listing order', () => {
        const plugins = store();

        expect(plugins.names()).toEqual(['alpha', 'beta']);
        expect(plugins.descriptors).toBe(FIXTURES);
        expect(plugins.metadata('alpha')?.title).toBe('Alpha');
        expect(plugins.metadata('missing')).toBeUndefined();
    });
});

describe('plugin settings store — validation at the write edge', () => {
    it('accepts an in-range value and reports the new effective map', () => {
        const plugins = store();

        expect(plugins.update('alpha', { limit: 250 })).toEqual({
            limit: 250,
            name: 'seed',
            enabled: false
        });
        expect(plugins.get('alpha', 'limit')).toBe(250);
        expect(plugins.revision()).toBe(1);
    });

    it('refuses a number outside the declared bounds, naming the bound', () => {
        const plugins = store();

        expect(failureOf(() => plugins.update('alpha', { limit: 9 }))).toEqual({
            status: 400,
            message: '"limit" of plugin "alpha" must be at least 10; 9 was submitted.'
        });

        expect(failureOf(() => plugins.update('alpha', { limit: 1001 }))).toEqual({
            status: 400,
            message: '"limit" of plugin "alpha" must be at most 1000; 1001 was submitted.'
        });

        // The bounds are inclusive, so both edges are accepted.
        expect(plugins.update('alpha', { limit: 10 }).limit).toBe(10);
        expect(plugins.update('alpha', { limit: 1000 }).limit).toBe(1000);

        // A rejected patch moved nothing and bumped no counter: two accepted writes above, and
        // the two refusals in between, leave the counter at 2.
        expect(plugins.get('alpha', 'limit')).toBe(1000);
        expect(plugins.revision()).toBe(2);
    });

    it('refuses a non-finite number and a non-numeric string', () => {
        const plugins = store();

        expect(failureOf(() => plugins.update('alpha', { limit: Number.NaN })).status).toBe(400);
        expect(failureOf(() => plugins.update('alpha', { limit: Number.POSITIVE_INFINITY })).status).toBe(400);
        expect(
            failureOf(() => plugins.update('alpha', { limit: '1e999' })).message
        ).toBe('"limit" of plugin "alpha" must be a finite number (it is declared "number").');
        expect(
            failureOf(() => plugins.update('alpha', { limit: 'ten' })).message
        ).toBe('"limit" of plugin "alpha" must be a finite number (it is declared "number").');
    });

    it('does NOT refuse a value off the declared step (a documented decision)', () => {
        const plugins = store();

        // `step: 10` is an editor hint: src/types/index.ts:3053-3056 and the header of
        // ../plugin/settings.ts both say min/max/step are not enforced at read time. A write
        // that refused 105 would be stricter than the runtime that has to live with it.
        expect(plugins.update('alpha', { limit: 105 })).toEqual({
            limit: 105,
            name: 'seed',
            enabled: false
        });
        expect(plugins.values('alpha').limit).toBe(105);
    });

    it('refuses a value whose type is not the declared one', () => {
        const plugins = store();

        expect(
            failureOf(() => plugins.update('alpha', { limit: true })).message
        ).toBe('"limit" of plugin "alpha" must be a finite number (it is declared "number").');

        // A `string` setting takes a string ONLY: unlike the read path, a write must say what
        // it means, so a number is a client bug rather than a value to coerce.
        expect(
            failureOf(() => plugins.update('alpha', { name: 7 })).message
        ).toBe('"name" of plugin "alpha" must be a string (it is declared "string").');

        expect(
            failureOf(() => plugins.update('alpha', { enabled: 'maybe' })).message
        ).toBe('"enabled" of plugin "alpha" must be true or false (it is declared "boolean").');

        expect(
            failureOf(() => plugins.update('alpha', { limit: { nested: 1 } })).status
        ).toBe(400);
        expect(plugins.snapshot()).toEqual({});
    });

    it('accepts the string forms the runtime itself parses, and normalizes to the declared type', () => {
        const plugins = store();

        plugins.update('alpha', { limit: '420', enabled: 'TRUE' });

        // Stored as a number and a boolean, never as the text that arrived: that is what keeps
        // `state.json` scalars and `values` typed.
        expect(plugins.get('alpha', 'limit')).toBe(420);
        expect(plugins.get('alpha', 'enabled')).toBe(true);
        expect(plugins.snapshot()).toEqual({ alpha: { limit: 420, enabled: true } });
    });

    it('refuses a key the plugin never declared, naming the declared set', () => {
        const plugins = store();

        expect(failureOf(() => plugins.update('alpha', { nope: 1 }))).toEqual({
            status: 400,
            message: 'Unknown setting "nope" for plugin "alpha". Allowed settings: limit, name, enabled.'
        });

        // A plugin that declares nothing still has ONE accepted key: the framework's
        // reserved `enabled` switch, which every plugin answers to (./plugins.ts).
        expect(failureOf(() => plugins.update('beta', { anything: 1 }))).toEqual({
            status: 400,
            message: 'Unknown setting "anything" for plugin "beta". Allowed settings: enabled.'
        });
    });

    it('refuses an unknown plugin with 404, and an empty or malformed patch with 400', () => {
        const plugins = store();

        expect(failureOf(() => plugins.update('gamma', { limit: 1 }))).toEqual({
            status: 404,
            message: 'Unknown plugin "gamma". This build ships: alpha, beta.'
        });

        expect(failureOf(() => plugins.update('alpha', {})).message).toBe(
            'A plugin settings patch must change at least one setting.'
        );

        expect(failureOf(() => plugins.update('alpha', undefined)).message).toBe(
            'A plugin settings patch requires a "settings" object.'
        );

        expect(failureOf(() => plugins.update('alpha', [] as never)).status).toBe(400);

        // Identity is resolved before the body shape, so an unknown plugin is 404 even for a
        // patch that would also have failed validation.
        expect(failureOf(() => plugins.update('gamma', {})).status).toBe(404);
    });

    it('applies a multi-key patch only when every key validates', () => {
        const plugins = store();

        const failure = failureOf(() => plugins.update('alpha', { limit: 500, enabled: true, name: 12 }));

        expect(failure.status).toBe(400);
        expect(plugins.get('alpha', 'limit')).toBeUndefined();
        expect(plugins.get('alpha', 'enabled')).toBeUndefined();
        expect(plugins.revision()).toBe(0);
    });
});

describe('plugin settings store — reset to the declared default', () => {
    it('drops one override on an explicit null and keeps the others', () => {
        const plugins = store();

        plugins.update('alpha', { limit: 250, name: 'custom' });
        expect(plugins.snapshot()).toEqual({ alpha: { limit: 250, name: 'custom' } });

        plugins.update('alpha', { limit: null });

        expect(plugins.get('alpha', 'limit')).toBeUndefined();
        expect(plugins.values('alpha')).toEqual({ limit: 100, name: 'custom', enabled: false });

        // A reset is a mutation, so it moves the collection counter.
        expect(plugins.revision()).toBe(2);

        // Clearing the LAST override leaves no empty entry, so `snapshot()` stays a delta and
        // `databaseRecord` keeps omitting the field entirely.
        plugins.update('alpha', { name: null });
        expect(plugins.snapshot()).toEqual({});
    });
});

describe('plugin settings store — the LIVE provider', () => {
    it('returns a value written AFTER the harness was built, through the same provider object', () => {
        const plugins = store();
        const provider = pluginSettingsProviderOf(plugins);

        // Exactly what `harness()` receives as `configuration.pluginSettings` (via
        // HarnessPresetReport.pluginSettings, ./harnesses/toolbox.ts).
        expect(provider).toBe(plugins.provider);

        // The per-plugin view is what `api.settings` IS (../plugin/host.ts:151 builds it from
        // this provider reference), so a read through it is the plugin's own read.
        const alpha = FIXTURES[0];
        const view = createPluginSettingsView('alpha', provider, alpha.settings);

        expect(view.number('limit')).toBe(100);
        expect(view.string('name')).toBe('seed');
        expect(view.boolean('enabled')).toBe(false);

        // An operator edit, then the SAME view — no rebuild, no new harness.
        plugins.update('alpha', { limit: 250, enabled: 'true' });

        expect(provider.get('alpha', 'limit')).toBe(250);
        expect(view.number('limit')).toBe(250);
        expect(view.boolean('enabled')).toBe(true);

        // A key nobody stored still reads `undefined` from the provider, which is the signal
        // for the view to fall back to the declared default.
        expect(provider.get('alpha', 'name')).toBeUndefined();
        expect(view.string('name')).toBe('seed');

        // A reset is visible the same way.
        plugins.update('alpha', { limit: null });
        expect(provider.get('alpha', 'limit')).toBeUndefined();
        expect(view.number('limit')).toBe(100);
        expect(view.number('missing', 7)).toBe(7);
    });
});

describe('plugin settings store — persistence round trip', () => {
    it('snapshots overrides only, in catalogue order', () => {
        const plugins = createPluginSettingsStore({
            descriptors: [
                { name: 'second', title: 'Second', settings: [{ key: 'b', label: 'B', type: 'string', default: '' }] },
                { name: 'first', title: 'First', settings: [{ key: 'a', label: 'A', type: 'number', default: 1 }] }
            ]
        });

        // Declared order inside one plugin, and catalogue order across plugins.
        plugins.update('first', { a: 5 });
        plugins.update('second', { b: 'x' });

        const saved = plugins.snapshot();

        expect(Object.keys(saved)).toEqual(['second', 'first']);
        expect(saved).toEqual({ second: { b: 'x' }, first: { a: 5 } });
        expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    });

    it('restores a saved document into a fresh store', () => {
        const original = store();

        original.update('alpha', { limit: 300, name: 'kept', enabled: true });

        const saved = original.snapshot();
        const reopened = createPluginSettingsStore({ descriptors: FIXTURES, values: saved });

        expect(reopened.get('alpha', 'limit')).toBe(300);
        expect(reopened.values('alpha')).toEqual({ limit: 300, name: 'kept', enabled: true });
        expect(reopened.snapshot()).toEqual(saved);

        // A boot is not a write: the counter restarts, exactly like every hub revision.
        expect(reopened.revision()).toBe(0);

        // The restored value is what a running session reads.
        expect(reopened.provider.get('alpha', 'limit')).toBe(300);
    });

    it('drops what this build no longer declares instead of failing the boot', () => {
        const saved = {
            // A plugin this build stopped shipping.
            retired: { limit: 5 },
            alpha: {
                limit: 400,
                // A key the plugin dropped between versions.
                gone: 'x',
                // A value of the wrong shape: restored as "nothing stored", not as an error.
                enabled: 3,
                name: 'kept'
            },
            // The persisted TYPE says "an object of objects"; a hand-edited document can hold
            // anything, and `restore` skips a non-object entry rather than throwing. Cast rather
            // than widening the record type, so `state.json` stays scalars-only by contract.
            beta: 'nope'
        } as unknown as HarnessPluginSettingsRecord;

        const plugins = createPluginSettingsStore({ descriptors: FIXTURES, values: saved });

        expect(plugins.snapshot()).toEqual({ alpha: { limit: 400, name: 'kept' } });
        expect(plugins.get('alpha', 'enabled')).toBeUndefined();
        expect(plugins.values('alpha')).toEqual({ limit: 400, name: 'kept', enabled: false });
    });

    it('treats an absent document field as "nothing has ever changed"', () => {
        const plugins = store();

        plugins.update('alpha', { limit: 11 });
        plugins.restore(undefined);

        expect(plugins.snapshot()).toEqual({});
        expect(plugins.values('alpha')).toEqual({ limit: 100, name: 'seed', enabled: false });
    });
});

describe('plugin settings store — the shipped built-in catalogue', () => {
    it('seeds from the generated manifest and lists the three built-ins', () => {
        const plugins = createPluginSettingsStore();

        // Manifest order is scan order (path ascending), which is what `GET /plugins` answers in.
        expect(plugins.names()).toEqual(['async-ping', 'context-compaction', 'context-trimmer']);
        expect(plugins.descriptors).toBe(BUILTIN_PLUGIN_DESCRIPTORS);
    });

    it('reports the declared defaults with no stored override', () => {
        const plugins = createPluginSettingsStore();

        expect(plugins.get('context-compaction', 'contextLimit')).toBeUndefined();
        expect(
            // EVERY declared default (compaction's limit/model-map/switch/floor/horizon/
            // mode, copied from src/plugins/context-compaction.plugin.ts), in the order the
            // descriptors are declared: this is the map the UI renders and the plugin reads
            // when the host has stored nothing.
            plugins.values('context-compaction')
        ).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });
        expect(plugins.values('async-ping')).toEqual({ intervalMs: 600000 });
        // The third built-in, as of the 2026-11-13 clean-up: `enabled` (the key the framework owns,
        // so the row's switch and its Rule-0 read are one value) plus the sixteen policy switches
        // declared by `src/plugins/context-trimmer.plugin.ts` — three toggle+horizon pairs (invalid
        // tools, thoughts, truncate tool requests), the two whole-unit rules with their own horizons,
        // and the four bounds/economy numbers. EVERY default is spelled out — this is the map the
        // Plugins pane renders and the plugin reads on a host that has stored nothing, so a default
        // that moves without a test noticing is a behaviour change nobody approved. The horizons
        // default to 2 (the newest two tool turns / thoughts are always protected); the shipped
        // posture is that every toggle except `truncateToolRequests` is on.
        //
        // The 2026-11-13 rename (`dropInvalidToolCallsOnceAnswered`→`trimInvalidTools`,
        // `dropOldThoughts`+`thoughtKeepUnits`→`trimThoughts`+`thoughtTurns`, plus the five new
        // horizon keys) has NO migration: a stored override under a retired key is simply ignored,
        // and a host that had customised the trimmer gets the declared defaults below until it
        // re-picks them in the pane.
        expect(plugins.values('context-trimmer')).toEqual({
            enabled: true,
            trimInvalidTools: true,
            invalidToolTurns: 2,
            trimThoughts: true,
            thoughtTurns: 2,
            truncateToolRequests: false,
            truncateTurns: 2,
            dropSupersededToolCalls: true,
            supersededTurns: 2,
            dropDuplicateCalls: false,
            duplicateTurns: 2,
            invalidOutcomes: 'failed,rejected',
            supersedeMatch: 'name',
            minTokens: 0,
            minThoughtChars: 0,
            safetyUnits: 0,
            maxUnits: 0
        });
        // `snapshot()` is the OVERRIDE map, not the effective map: nothing has been written, so
        // seventeen new descriptors seed no overrides at all.
        expect(plugins.snapshot()).toEqual({});
    });

    it('enforces context-compaction\'s real bounds (min 1000, no max)', () => {
        const plugins = createPluginSettingsStore();

        expect(failureOf(() => plugins.update('context-compaction', { contextLimit: 999 })).message).toBe(
            '"contextLimit" of plugin "context-compaction" must be at least 1000; 999 was submitted.'
        );

        // `max` is undeclared, so any larger finite limit is a legitimate operator choice.
        // `update` answers with the FULL effective map, so a UI that re-renders the row after
        // a PATCH shows every declared setting at its effective value: the override for
        // `contextLimit`, and the declared default for the other five.
        expect(plugins.update('context-compaction', { contextLimit: 250000 })).toEqual({
            contextLimit: 250000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });
        expect(plugins.provider.get('context-compaction', 'contextLimit')).toBe(250000);
        expect(plugins.snapshot()).toEqual({ 'context-compaction': { contextLimit: 250000 } });

        // And a 0 (compact every turn) is below the declared floor.
        expect(failureOf(() => plugins.update('context-compaction', { contextLimit: 0 })).status).toBe(400);
    });
});

// ---------------------------------------------------------------------------
// R2 — THE RESERVED `enabled` KEY (the operator's global plugin switch)
//
// Appended by the enablement work. Every assertion is exact (`toEqual`/`toBe`), and the
// fixture catalogue is the one at the top of this file: `alpha` DECLARES `enabled`
// (default false, its own descriptor) and `beta` declares NOTHING (so the synthesized
// reserved descriptor is the only key it answers to).
//
// Cross-references:
//   - ./plugins.ts       — `PLUGIN_ENABLED_KEY`, `RESERVED_ENABLED_DESCRIPTOR`, `enabled()`
//   - ../plugin/host.ts  — the hook gate that reads the same stored value through the provider
//   - ../plugin/hooks.ts — rule 9 (a gated owner is inert, not unregistered)
describe('plugin settings store — the reserved `enabled` switch (R2)', () => {
    it('answers the declared default for a declaring plugin and `true` for one that declares nothing', () => {
        const plugins = store();

        // `alpha` declares `enabled: false`, so the plugin owns the answer and the
        // framework honours it — one stored value, read the same way by the gate.
        expect(plugins.enabled('alpha')).toBe(false);

        // `beta` declares no settings at all and still answers to the switch: the
        // synthesized descriptor's `default: true` is the fallback.
        expect(plugins.enabled('beta')).toBe(true);

        // Nothing was stored to get there: the key is resolved, never seeded.
        expect(plugins.get('alpha', PLUGIN_ENABLED_KEY)).toBeUndefined();
        expect(plugins.get('beta', PLUGIN_ENABLED_KEY)).toBeUndefined();
        expect(plugins.snapshot()).toEqual({});

        // An unknown plugin is a total read (the ROUTE resolves identity with a 404), and
        // its answer is the same default.
        expect(plugins.enabled('missing')).toBe(true);
    });

    it('accepts `enabled` for a plugin that never declares it, and keeps `values` declared-only', () => {
        const plugins = store();

        // The update result is the EFFECTIVE map of declared keys, which for `beta` is
        // still empty — the switch is the row's own `enabled` field, never a `values` entry
        // (../shared/harness-api.ts `PluginSummary.values`: a key absent from `settings`
        // can never appear there).
        expect(plugins.update('beta', { [PLUGIN_ENABLED_KEY]: false })).toEqual({});
        expect(plugins.enabled('beta')).toBe(false);
        expect(plugins.get('beta', PLUGIN_ENABLED_KEY)).toBe(false);

        // A second flip is a normal write, not a special case.
        plugins.update('beta', { [PLUGIN_ENABLED_KEY]: true });
        expect(plugins.enabled('beta')).toBe(true);

        // `values('beta')` never grew a key: the declared projection is unchanged.
        expect(plugins.values('beta')).toEqual({});
        expect(plugins.settingsOf('beta')).toEqual([]);

        // And the write IS allowlisted, so the accepted set names the reserved key.
        expect(plugins.effectiveSettingsOf('beta').map((entry) => entry.key)).toEqual([PLUGIN_ENABLED_KEY]);
        expect(plugins.effectiveSettingsOf('alpha').map((entry) => entry.key)).toEqual([
            'limit',
            'name',
            'enabled'
        ]);
    });

    it('persists the switch for a non-declaring plugin and restores it on the next boot', () => {
        const plugins = store();

        plugins.update('beta', { [PLUGIN_ENABLED_KEY]: false });

        // The snapshot carries the override even though `beta` declares no descriptor of
        // its own — `snapshotOf` walks the EFFECTIVE list.
        expect(plugins.snapshot()).toEqual({ beta: { [PLUGIN_ENABLED_KEY]: false } });

        const reopened = createPluginSettingsStore({
            descriptors: FIXTURES,
            values: plugins.snapshot()
        });

        expect(reopened.enabled('beta')).toBe(false);
        expect(reopened.snapshot()).toEqual({ beta: { [PLUGIN_ENABLED_KEY]: false } });

        // A restore is not a write, so the new process starts its own counter at zero.
        expect(reopened.revision()).toBe(0);
    });

    it('honours a declaring plugin\'s own default, and puts the switch back on a null reset', () => {
        const plugins = store();

        // `alpha` defaults to OFF, and a reset lands back on THAT, not on `true`.
        expect(plugins.enabled('alpha')).toBe(false);

        plugins.update('alpha', { [PLUGIN_ENABLED_KEY]: true });
        expect(plugins.enabled('alpha')).toBe(true);
        expect(plugins.snapshot()).toEqual({ alpha: { [PLUGIN_ENABLED_KEY]: true } });

        plugins.update('alpha', { [PLUGIN_ENABLED_KEY]: null });
        expect(plugins.enabled('alpha')).toBe(false);
        expect(plugins.get('alpha', PLUGIN_ENABLED_KEY)).toBeUndefined();

        // The reset is a mutation, so it moves the collection counter (two accepted PATCHes).
        expect(plugins.revision()).toBe(2);
        expect(plugins.snapshot()).toEqual({});
    });

    it('refuses a non-boolean `enabled` with the declared-type message, accepting the words the runtime parses', () => {
        const plugins = store();

        expect(failureOf(() => plugins.update('beta', { [PLUGIN_ENABLED_KEY]: 'yes' }))).toEqual({
            status: 400,
            message: '"enabled" of plugin "beta" must be true or false (it is declared "boolean").'
        });

        expect(failureOf(() => plugins.update('beta', { [PLUGIN_ENABLED_KEY]: 0 }))).toEqual({
            status: 400,
            message: '"enabled" of plugin "beta" must be true or false (it is declared "boolean").'
        });

        // A refused switch mutated nothing.
        expect(plugins.enabled('beta')).toBe(true);
        expect(plugins.revision()).toBe(0);

        // The string forms the read path also accepts are normalized to a real boolean, so
        // a stored override is always exactly the declared type (and JSON-representable).
        plugins.update('beta', { [PLUGIN_ENABLED_KEY]: 'FALSE' });
        expect(plugins.get('beta', PLUGIN_ENABLED_KEY)).toBe(false);
        expect(plugins.enabled('beta')).toBe(false);
    });

    it('drives the SAME provider read the harness gate performs, live and by reference', () => {
        const plugins = store();
        const provider = plugins.provider;

        // The provider is the harness's only path to the switch (`../plugin/host.ts` builds
        // each plugin's settings view over it), so this is the exact question the gate asks.
        expect(plugins.enabled('beta')).toBe(true);
        expect(provider.get('beta', PLUGIN_ENABLED_KEY)).toBeUndefined();

        plugins.update('beta', { [PLUGIN_ENABLED_KEY]: false });

        expect(provider.get('beta', PLUGIN_ENABLED_KEY)).toBe(false);
        expect(plugins.enabled('beta')).toBe(false);

        // Identity is stable for the process, which is what lets a harness built before the
        // write see the value after it.
        expect(plugins.provider).toBe(provider);
    });

    it('leaves the shipped catalogue resolvable through the reserved key', () => {
        // The real built-ins, no fixtures: `async-ping` does NOT declare `enabled`, and
        // `context-compaction` DOES, so one shipped build exercises both halves of the
        // synthesized-vs-declared rule.
        const plugins = createPluginSettingsStore();

        expect(BUILTIN_PLUGIN_DESCRIPTORS.map((entry) => entry.name)).toEqual([
            'async-ping',
            'context-compaction',
            'context-trimmer'
        ]);
        expect(plugins.settingsOf('async-ping').map((entry) => entry.key)).toEqual(['intervalMs']);
        expect(plugins.effectiveSettingsOf('async-ping').map((entry) => entry.key)).toEqual([
            'intervalMs',
            PLUGIN_ENABLED_KEY
        ]);

        expect(plugins.update('async-ping', { [PLUGIN_ENABLED_KEY]: false })).toEqual({ intervalMs: 600000 });
        expect(plugins.enabled('async-ping')).toBe(false);
        expect(plugins.snapshot()).toEqual({ 'async-ping': { [PLUGIN_ENABLED_KEY]: false } });

        // Compaction's declared key is the one its Rule-0 read already consults, so the
        // framework gate and the plugin cannot disagree.
        expect(plugins.enabled('context-compaction')).toBe(true);
        expect(plugins.update('context-compaction', { [PLUGIN_ENABLED_KEY]: false })).toMatchObject({
            enabled: false
        });
        expect(plugins.enabled('context-compaction')).toBe(false);
    });
});
