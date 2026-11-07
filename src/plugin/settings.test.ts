// Plugin settings (src/plugin/settings.ts).
//
// Pins the two rules the framework rests on:
//   - resolution order for every accessor: stored value -> declared default -> the
//     caller's fallback -> the accessor's neutral value;
//   - TYPE coercion, not range validation. A stored value of the wrong shape is a corrupt
//     host document, and handing a plugin `NaN` or the string `"false"` is worse than
//     falling back. `min`/`max`/`step` are UI hints and are deliberately NOT enforced, so
//     an out-of-range operator value is honoured rather than silently clamped.

import { describe, expect, it } from 'vitest';
import { createInMemoryPluginSettingsProvider, createPluginSettingsView } from './settings';
import type { HarnessPluginMetadata } from '../types';

// One plugin with one setting of each type, plus an out-of-range number to prove the
// hints are not enforced at read time.
const metadata: readonly HarnessPluginMetadata[] = [
    {
        name: 'demo',
        title: 'Demo',
        builtin: true,
        settings: [
            { key: 'limit', label: 'Limit', type: 'number', default: 100, min: 10, max: 50 },
            { key: 'model', label: 'Model', type: 'string', default: 'fast' },
            { key: 'enabled', label: 'Enabled', type: 'boolean', default: true }
        ]
    },
    { name: 'plain', title: 'Plain' }
];

describe('createInMemoryPluginSettingsProvider', () => {
    it('answers from the declared defaults when nothing else is stored', () => {
        const provider = createInMemoryPluginSettingsProvider(metadata);

        expect(provider.get('demo', 'limit')).toBe(100);
        expect(provider.get('demo', 'model')).toBe('fast');
        expect(provider.get('demo', 'enabled')).toBe(true);
        // A plugin with no descriptors has no entries at all: `undefined`, so the
        // caller's own fallback applies.
        expect(provider.get('plain', 'anything')).toBeUndefined();
        expect(provider.get('nobody', 'limit')).toBeUndefined();
    });

    it('applies the seed over the defaults and drops undefined seed entries', () => {
        const provider = createInMemoryPluginSettingsProvider(metadata, {
            demo: { limit: 7, model: undefined },
            'async-ping': { intervalMs: 5000 }
        });

        expect(provider.get('demo', 'limit')).toBe(7);
        // An `undefined` seed value does NOT erase the declared default.
        expect(provider.get('demo', 'model')).toBe('fast');
        // A seed may name a plugin that declared nothing (the legacy `wakeIntervalMs`
        // mapping is exactly this shape).
        expect(provider.get('async-ping', 'intervalMs')).toBe(5000);
    });

    it('stores per plugin namespace, and snapshot() mirrors the whole table', () => {
        const provider = createInMemoryPluginSettingsProvider(metadata);

        provider.set('other', 'limit', 1);

        expect(provider.get('demo', 'limit')).toBe(100);
        expect(provider.get('other', 'limit')).toBe(1);
        expect(provider.snapshot()).toEqual({
            demo: { limit: 100, model: 'fast', enabled: true },
            other: { limit: 1 }
        });
    });
});

describe('createPluginSettingsView', () => {
    it('reads through the provider with the plugin name as the namespace', () => {
        const asked: string[] = [];
        const view = createPluginSettingsView('demo', {
            get: (plugin, key) => {
                asked.push(`${plugin}.${key}`);
                return undefined;
            }
        });

        expect(view.number('limit', 3)).toBe(3);
        expect(view.string('model', 'x')).toBe('x');
        expect(view.boolean('enabled', false)).toBe(false);

        // No descriptors were passed to the view, so no declared default exists and the
        // argument fallback is the answer. The plugin name is what the host is asked for.
        expect(asked).toEqual(['demo.limit', 'demo.model', 'demo.enabled']);
    });

    it('prefers a stored value, then the declared default, then the argument', () => {
        const store: Record<string, unknown> = { limit: 42, model: null };
        const view = createPluginSettingsView(
            'demo',
            { get: (_plugin, key) => store[key] },
            metadata[0].settings
        );

        expect(view.number('limit')).toBe(42);
        // `null` counts as "nothing stored", so the declared default applies.
        expect(view.string('model')).toBe('fast');
        // An undeclared key with nothing stored falls back to the argument.
        expect(view.number('missing', 9)).toBe(9);
        expect(view.string('missing', 's')).toBe('s');
        expect(view.boolean('missing', true)).toBe(true);
        // No argument and no descriptor -> the accessor's neutral value.
        expect(view.string('missing')).toBe('');
        expect(view.boolean('missing')).toBe(false);
        expect(Number.isNaN(view.number('missing'))).toBe(true);
    });

    it('coerces the right types and refuses the wrong ones', () => {
        const store: Record<string, unknown> = {
            // A JSON document or a query parameter stores numbers as text.
            numericText: '250',
            badNumber: 'abc',
            nanNumber: Number.NaN,
            boolText: 'TRUE',
            boolNumber: 1,
            numberForBoolean: 0,
            objectForString: { a: 1 }
        };
        const view = createPluginSettingsView('demo', { get: (_plugin, key) => store[key] });

        expect(view.number('numericText', 1)).toBe(250);
        expect(view.number('badNumber', 1)).toBe(1);
        expect(view.number('nanNumber', 1)).toBe(1);
        // Boolean text is accepted case-insensitively; a number is NOT a boolean.
        expect(view.boolean('boolText', false)).toBe(true);
        expect(view.boolean('boolNumber', false)).toBe(false);
        expect(view.boolean('numberForBoolean', true)).toBe(true);
        // Scalars stringify; an object is not readable text.
        expect(view.string('boolNumber', 'fb')).toBe('1');
        expect(view.string('objectForString', 'fb')).toBe('fb');
    });

    it('honours an out-of-range stored value instead of clamping it', () => {
        // `limit` declares min 10 / max 50; the operator stored 1000. Clamping would
        // hide a mistake the UI can already show.
        const view = createPluginSettingsView(
            'demo',
            { get: (_plugin, key) => (key === 'limit' ? 1000 : undefined) },
            metadata[0].settings
        );

        expect(view.number('limit')).toBe(1000);
    });

    it('re-reads the provider on every access (no captured value)', () => {
        let stored: unknown = 1;
        const view = createPluginSettingsView('demo', { get: () => stored }, metadata[0].settings);

        expect(view.number('limit')).toBe(1);
        stored = 2;
        // A settings change must be visible on the NEXT turn without rebuilding the
        // harness — that is the whole reason this is a function call, not a snapshot.
        expect(view.number('limit')).toBe(2);
    });

    it('exposes the raw stored value through get()', () => {
        const view = createPluginSettingsView(
            'demo',
            { get: (_plugin, key) => (key === 'limit' ? 'oops' : undefined) },
            metadata[0].settings
        );

        // `get` is honest about what the host stored; coercion lives in the typed
        // accessors, so a host can still diagnose the bad value.
        expect(view.get('limit')).toBe('oops');
        expect(view.number('limit')).toBe(100);
    });
});
