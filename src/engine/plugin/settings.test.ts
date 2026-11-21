// Plugin settings (src/plugin/settings.ts).
//
// Pins the two rules the framework rests on:
//   - resolution order for every accessor: stored value -> declared default -> the
//     caller's fallback -> the accessor's neutral value;
//   - TYPE coercion, not range validation, at the READ edge. A stored value of the wrong
//     shape is a corrupt host document, and handing a plugin `NaN` or the string `"false"`
//     is worse than falling back. `min`/`max`/`step` are UI hints and are deliberately NOT
//     enforced on a read, so an out-of-range operator value is honoured rather than
//     silently clamped.
//   - the opposite at the WRITE edge (T3.5, `setOwn`): the declared key set, the declared
//     type and `min`/`max` ARE enforced, the value is normalized to the declared type, and
//     a provider without a writer is refused rather than quietly kept. See the `setOwn`
//     section at the end of this file.

import { describe, expect, it } from 'vitest';
import { createInMemoryPluginSettingsProvider, createPluginSettingsView } from './settings';
import { HarnessError } from '../util';
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

// ---------------------------------------------------------------------------
// `setOwn` — the WRITE edge (pipeline T3.5)
// ---------------------------------------------------------------------------
// The read path stays coercive and the write path stays strict; these tests pin the
// difference. The rules are the ones src/server/plugins.ts applies at
// `PATCH /v1/harness/plugins/{plugin_id}` (declared key, declared type, `min`/`max`,
// `step` NOT enforced, normalization to the declared type), restated in the plugin layer
// so a plugin cannot persist a value its own read path would then silently ignore.

describe('api.settings.setOwn (the only write on this surface)', () => {
    // A provider WITH the optional writer, recording what the host was handed.
    const writable = (initial: Record<string, unknown> = {}) => {
        const store: Record<string, unknown> = { ...initial };
        const writes: Array<[string, string, unknown]> = [];

        return {
            writes,
            provider: {
                get: (plugin: string, key: string) => store[`${plugin}.${key}`],
                set: (plugin: string, key: string, value: number | string | boolean) => {
                    writes.push([plugin, key, value]);
                    store[`${plugin}.${key}`] = value;
                }
            }
        };
    };

    // Refusal messages of a list of calls, in call order.
    const refusals = (calls: Array<() => void>): string[] =>
        calls.reduce<string[]>((failures, call) => {
            try {
                call();
            } catch (error) {
                failures.push((error as Error).message);
            }

            return failures;
        }, []);

    it('writes its OWN namespace, normalized to the declared type, and the read path sees it', () => {
        const { writes, provider } = writable();
        const view = createPluginSettingsView('demo', provider, metadata[0].settings);

        // A numeric string and the words 'true'/'false' are what a query parameter or a
        // JSON document legitimately carries, and they are NORMALIZED on the way in.
        view.setOwn('limit', '25');
        view.setOwn('enabled', 'false');
        view.setOwn('model', 'slow');

        expect(writes).toEqual([
            ['demo', 'limit', 25],
            ['demo', 'enabled', false],
            ['demo', 'model', 'slow']
        ]);
        // Read-your-writes through the same coercive accessors.
        expect(view.number('limit')).toBe(25);
        expect(view.boolean('enabled')).toBe(false);
        expect(view.string('model')).toBe('slow');
    });

    it('refuses a key the plugin does not declare, naming the declared set', () => {
        const { writes, provider } = writable();
        const view = createPluginSettingsView('demo', provider, metadata[0].settings);
        const plainView = createPluginSettingsView('plain', provider);

        expect(
            refusals([
                () => view.setOwn('limitt', 25),
                () => view.setOwn('', 1),
                () => plainView.setOwn('anything', 1)
            ])
        ).toEqual([
            'settings.setOwn received "limitt", which plugin "demo" does not declare (declared: "limit", "model", "enabled").',
            'settings.setOwn received "", which plugin "demo" does not declare (declared: "limit", "model", "enabled").',
            'settings.setOwn received "anything", which plugin "plain" does not declare (it declares no settings).'
        ]);

        // A refused key is never stored, so it cannot become an override that reads back as
        // a default forever.
        expect(writes).toEqual([]);
    });

    it('enforces min/max and the declared type, and never enforces step', () => {
        const { writes, provider } = writable();
        const view = createPluginSettingsView('demo', provider, metadata[0].settings);

        expect(
            refusals([
                () => view.setOwn('limit', 9),
                () => view.setOwn('limit', 51),
                () => view.setOwn('limit', 'abc'),
                () => view.setOwn('limit', Number.NaN),
                () => view.setOwn('limit', null),
                () => view.setOwn('limit', undefined),
                () => view.setOwn('model', 12),
                () => view.setOwn('enabled', 'yes'),
                () => view.setOwn('enabled', 1)
            ])
        ).toEqual([
            '"limit" of plugin "demo" must be at least 10; 9 was submitted.',
            '"limit" of plugin "demo" must be at most 50; 51 was submitted.',
            '"limit" of plugin "demo" must be a finite number (it is declared "number").',
            '"limit" of plugin "demo" must be a finite number (it is declared "number").',
            // `null`/`undefined` are NOT a reset here: a reset is the host PATCH edge's
            // documented semantic, and this surface has no way to say "delete the key".
            '"limit" of plugin "demo" must be a finite number (it is declared "number").',
            '"limit" of plugin "demo" must be a finite number (it is declared "number").',
            '"model" of plugin "demo" must be a string (it is declared "string").',
            '"enabled" of plugin "demo" must be true or false (it is declared "boolean").',
            '"enabled" of plugin "demo" must be true or false (it is declared "boolean").'
        ]);
        expect(writes).toEqual([]);

        // The bounds the plugin PUBLISHED are enforced; `step` is a UI hint on both edges,
        // so refusing 1500 because `step: 1000` would be stricter than the runtime.
        const stepped = writable();
        const steppedView = createPluginSettingsView('demo', stepped.provider, [
            { key: 'quota', label: 'Quota', type: 'number', default: 1000, min: 1, step: 1000 }
        ]);
        steppedView.setOwn('quota', 1500);
        expect(stepped.writes).toEqual([['demo', 'quota', 1500]]);
        expect(steppedView.number('quota')).toBe(1500);
    });

    it('refuses to write when the host has no writer, and reports a caller typo first', () => {
        // The shipped server's live provider is exactly this shape: `get` only, so its
        // store's own PATCH edge stays the one that validates and persists.
        const readOnly = { get: () => undefined };
        const view = createPluginSettingsView('demo', readOnly, metadata[0].settings);

        expect(() => view.setOwn('limit', 25)).toThrow(
            new HarnessError(
                'settings.setOwn cannot store "limit" of plugin "demo": this harness\'s plugin-settings provider is read-only (no writer).'
            )
        );

        // Order is all-or-nothing and the CALLER'S error is the actionable one: an
        // undeclared key on a read-only host still reports the key, not the host's limit.
        expect(
            refusals([() => view.setOwn('nope', 25), () => view.setOwn('limit', 900)])
        ).toEqual([
            'settings.setOwn received "nope", which plugin "demo" does not declare (declared: "limit", "model", "enabled").',
            '"limit" of plugin "demo" must be at most 50; 900 was submitted.'
        ]);
    });
});
