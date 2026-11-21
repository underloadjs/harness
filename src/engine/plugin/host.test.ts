// Plugin precedence and the per-plugin api (src/plugin/host.ts).
//
// The framework's one surprising rule is the one this file pins: auto-discovered
// built-ins are applied FIRST and a `configuration.plugins` entry with the SAME NAME
// replaces the built-in in place. Everything else here is what makes the shared api
// safe to hand to N plugins at once — `on` and `settings` are per-plugin, the rest is
// shared by reference.

import { describe, expect, it } from 'vitest';
import { resolvePluginList, runPlugins } from './host';
import { createHookBus } from './hooks';
import { createInMemoryPluginSettingsProvider } from './settings';
import type { HarnessPluginApiBase, HarnessPluginHostOptions } from './host';
import type { HarnessPlugin, HarnessThreadRecord } from '../types';

// A base api that records what a setup() call actually used. Every member is a stub, so
// an accidental extra call shows up in `used` instead of passing silently.
const fakeBase = (used: string[]): HarnessPluginApiBase => {
    const record: HarnessThreadRecord = {
        id: 'thread-9',
        agent: 'writer',
        origin: 'host',
        status: 'idle',
        sequence: 9
    };

    return {
        agents: { writer: { name: 'writer' } },
        tools: { read: { name: 'read' } },
        createAgent: (name) => {
            used.push(`createAgent:${name}`);
            return { name } as never;
        },
        addTool: (name) => {
            used.push(`addTool:${name}`);
            return { name } as never;
        },
        addCommand: (name) => {
            used.push(`addCommand:${name}`);
            return { name } as never;
        },
        threads: {
            list: () => {
                used.push('threads.list');
                return [record];
            },
            create: (agent) => {
                used.push(`threads.create:${agent}`);
                return record;
            },
            remove: (threadId) => {
                used.push(`threads.remove:${threadId}`);
            },
            delete: (threadId) => {
                used.push(`threads.delete:${threadId}`);
            },
            stop: (threadId, reason) => {
                used.push(`threads.stop:${threadId}:${reason ?? ''}`);
                return true;
            },
            send: (threadId, input) => {
                used.push(`threads.send:${threadId}:${input}`);
                return Promise.resolve({
                    role: 'assistant',
                    content: 'ok',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm',
                    stopReason: 'stop'
                });
            },
            steer: (threadId, text) => {
                used.push(`threads.steer:${threadId}:${text}`);
                return { threadId, queued: true };
            },
            messages: (threadId) => {
                used.push(`threads.messages:${threadId}`);
                return [];
            },
            replaceMessages: (threadId, messages) => {
                used.push(`threads.replaceMessages:${threadId}:${messages.length}`);
            },
            setStatus: (threadId, status) => {
                used.push(`threads.setStatus:${threadId}:${status}`);
                return record;
            }
        },
        enableTool: (name) => {
            used.push(`enableTool:${name}`);
        },
        disableTool: (name) => {
            used.push(`disableTool:${name}`);
        },
        enabledTools: () => {
            used.push('enabledTools');
            return ['read'];
        },
        async: {
            pending: (agent) => {
                used.push(`async.pending:${agent ?? '*'}`);
                return [];
            },
            wake: (agent) => {
                used.push(`async.wake:${agent ?? '*'}`);
            }
        },
        config: { wakeIntervalMs: 600000 }
    };
};

// Runs the host with a fresh bus/provider and returns what setup() used plus the
// recorded lifecycle names. R2: the provider itself is returned too, because the global
// enablement tests write the reserved `enabled` key through it AFTER setup() — that is the
// exact shape of an operator's click reaching an already-built harness.
const apply = (
    builtins: readonly HarnessPlugin[],
    plugins: readonly HarnessPlugin[],
    options: Partial<HarnessPluginHostOptions> = {}
) => {
    const used: string[] = [];
    const hooks = createHookBus();
    const settings = createInMemoryPluginSettingsProvider(
        [...builtins, ...plugins]
            .map((plugin) => plugin.metadata)
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    );
    const apiBase = fakeBase(used);

    const result = runPlugins({ builtins, plugins, hooks, settings, apiBase, ...options });

    return { used, hooks, result, settings };
};

describe('resolvePluginList', () => {
    const builtinA: HarnessPlugin = { name: 'alpha', metadata: { name: 'alpha', title: 'A', builtin: true } };
    const builtinB: HarnessPlugin = { name: 'beta', metadata: { name: 'beta', title: 'B', builtin: true } };

    it('applies built-ins first and keeps host order after them', () => {
        expect(resolvePluginList([builtinA, builtinB], []).map((entry) => [entry.plugin.name, entry.builtin])).toEqual([
            ['alpha', true],
            ['beta', true]
        ]);

        expect(
            resolvePluginList([builtinA, builtinB], [{ name: 'gamma' }, { name: 'delta' }]).map((entry) => [
                entry.plugin.name,
                entry.builtin
            ])
        ).toEqual([
            ['alpha', true],
            ['beta', true],
            ['gamma', false],
            ['delta', false]
        ]);
    });

    it('replaces a same-name built-in IN PLACE, so hook order is unchanged', () => {
        const replacement: HarnessPlugin = { name: 'beta', metadata: { name: 'beta', title: 'My beta' } };

        // Position is part of the documented order: a replacement that moved to the end
        // would change when its hooks fire relative to every other plugin's.
        expect(
            resolvePluginList([builtinA, builtinB], [replacement]).map((entry) => [
                entry.plugin.name,
                entry.builtin,
                entry.plugin.metadata?.title
            ])
        ).toEqual([
            ['alpha', true, 'A'],
            ['beta', false, 'My beta']
        ]);
    });

    it('rejects a duplicate host plugin and a plugin with no name', () => {
        expect(() => resolvePluginList([], [{ name: 'x' }, { name: 'x' }])).toThrow(
            'Plugin "x" is registered more than once.'
        );

        expect(() => resolvePluginList([], [{ name: '' }])).toThrow('A plugin requires a name.');

        // Two built-ins with one name is a scan bug (the generator rejects it first), but
        // the resolver refuses it too so a hand-fed list cannot produce it.
        expect(() => resolvePluginList([builtinA, builtinA], [])).toThrow(
            'Plugin "alpha" is registered more than once.'
        );
    });
});

describe('runPlugins', () => {
    it('runs each setup exactly once, in resolved order', () => {
        const order: string[] = [];
        const trace = (name: string): HarnessPlugin => ({
            name,
            setup: () => {
                order.push(name);
            }
        });

        const { result } = apply([trace('builtin-one'), trace('builtin-two')], [trace('host-one')]);

        expect(order).toEqual(['builtin-one', 'builtin-two', 'host-one']);
        expect(result.names).toEqual(['builtin-one', 'builtin-two', 'host-one']);
    });

    it('does NOT run a replaced built-in at all', () => {
        const order: string[] = [];
        const builtins: HarnessPlugin[] = [
            {
                name: 'shipped',
                metadata: { name: 'shipped', title: 'Shipped', builtin: true },
                setup: () => {
                    order.push('shipped');
                }
            }
        ];
        const plugins: HarnessPlugin[] = [
            {
                name: 'shipped',
                setup: () => {
                    order.push('replacement');
                }
            }
        ];

        const { result } = apply(builtins, plugins);

        // The point of replacement: the shipped plugin's hooks are never registered, so a
        // host that swaps the compaction plugin out does not run two compactors.
        expect(order).toEqual(['replacement']);
        expect(result.names).toEqual(['shipped']);
        expect(result.metadata).toEqual([{ name: 'shipped', title: 'shipped', builtin: false }]);
    });

    it('synthesizes metadata for a plugin that declares none, and keeps a built-in copy', () => {
        const { result } = apply(
            [{ name: 'alpha', metadata: { name: 'alpha', title: 'Alpha', version: '2.1.0', builtin: true } }],
            [{ name: 'beta' }]
        );

        expect(result.metadata).toEqual([
            { name: 'alpha', title: 'Alpha', version: '2.1.0', builtin: true },
            { name: 'beta', title: 'beta', builtin: false }
        ]);
    });

    it('scopes `settings` to the plugin name and its own declared defaults', () => {
        const seen: Record<string, unknown> = {};
        const withSetting = (name: string, fallback: number): HarnessPlugin => ({
            name,
            metadata: {
                name,
                title: name,
                settings: [{ key: 'limit', label: 'Limit', type: 'number', default: fallback }]
            },
            setup: (api) => {
                seen[name] = api.settings.number('limit');
            }
        });

        apply([withSetting('alpha', 10)], [withSetting('beta', 20)]);

        // Two plugins declaring the SAME key never see each other's value: the provider is
        // keyed by plugin name, and the fallback comes from that plugin's own descriptor.
        expect(seen).toEqual({ alpha: 10, beta: 20 });
    });

    it('gives every plugin the shared api surface plus its own on/settings', () => {
        const used: string[] = [];
        const probe: HarnessPlugin = {
            name: 'probe',
            setup: (api) => {
                api.threads.list();
                api.threads.create('writer');
                api.enableTool('read');
                api.disableTool('write');
                void api.enabledTools();
                void api.async.pending();
                api.async.wake('writer');
                used.push(`config:${api.config.wakeIntervalMs}`);
                used.push(`agents:${Object.keys(api.agents).join(',')}`);
                used.push(`tools:${Object.keys(api.tools).join(',')}`);
            }
        };

        const { result } = apply([probe], []);

        expect(used).toEqual(['config:600000', 'agents:writer', 'tools:read']);
        expect(result.names).toEqual(['probe']);
    });

    it('routes `on` through the shared bus so a host can emit and unsubscribe', async () => {
        let unsubscribe!: () => void;
        const plugin: HarnessPlugin = {
            name: 'watcher',
            metadata: { name: 'watcher', title: 'Watcher', builtin: true },
            setup: (api) => {
                unsubscribe = api.on('thread.deleted', (payload) => {
                    seen.push(payload.threadId);
                });
            }
        };
        const seen: string[] = [];

        const { hooks } = apply([plugin], []);

        await hooks.emit('thread.deleted', { threadId: 'thread-1', agent: 'writer' });
        unsubscribe();
        await hooks.emit('thread.deleted', { threadId: 'thread-2', agent: 'writer' });

        expect(seen).toEqual(['thread-1']);
        // The bus records the OWNING plugin, which is what the UI shows as the live hook
        // surface (as opposed to the declared `metadata.hooks`).
        expect(hooks.live()).toEqual({});
    });

    it('hands a turn.before handler ITS OWN api, not another plugin\'s', async () => {
        const names: string[] = [];

        const make = (name: string): HarnessPlugin => ({
            name,
            metadata: {
                name,
                title: name,
                settings: [{ key: 'marker', label: 'Marker', type: 'string', default: name }]
            },
            setup: (api) => {
                api.on('turn.before', (payload) => {
                    names.push(payload.api.settings.string('marker'));
                });
            }
        });

        const { hooks } = apply([make('alpha'), make('beta')], []);

        await hooks.emit('turn.before', ({ api }) => ({
            threadId: 'thread-1',
            agent: 'writer',
            iteration: 1,
            messages: [],
            estimatedTokens: 0,
            signal: new AbortController().signal,
            api: api as never,
            setTranscript: () => undefined,
            replaceHistory: () => undefined,
            pause: async () => undefined,
            resume: async () => undefined
        }));

        // Without per-registration api wiring, both handlers would read one plugin's
        // settings and the second plugin would compact against the wrong limit.
        expect(names).toEqual(['alpha', 'beta']);
    });
});

// ---------------------------------------------------------------------------
// R2 — THE GLOBAL ENABLEMENT GATE (the framework half of the operator's switch)
//
// What is pinned here is the rule a plugin author can rely on but cannot implement
// themselves: every hook delivery is gated on the plugin's OWN live settings view
// (`boolean('enabled', true)`), `harness.dispose` is the one exempt event, and the
// provider is re-read per delivery so a write after setup() changes behaviour on the
// very next emit. The bus side of the same rule (rule 9: inert, not unregistered) is
// pinned in ./hooks.test.ts; the REST + durability side in ../server/plugins.test.ts
// and ../server/plugins-api.test.ts.
//
// Cross-references:
//   - ./hooks.ts              — `isDeliverable`, `gated`, the `has()` skip, rule 9
//   - ../server/plugins.ts    — the reserved key, the synthesized descriptor, the live provider
//   - ../harness.ts           — `emitDispose`, and the emit sites guarded by `has()`
// ---------------------------------------------------------------------------

describe('runPlugins — the global enablement gate (R2)', () => {
    // A minimal `run.started` payload: the bus passes payloads through untouched, so the
    // smallest member the contract allows is the honest test input.
    const runContext = { agent: 'writer', depth: 0, input: 'hello' };

    /** A plugin that declares NOTHING — the async-ping shape, gated only by the reserved key. */
    const plainPlugin = (name: string, log: string[]): HarnessPlugin => ({
        name,
        metadata: { name, title: name, builtin: true },
        setup: (api) => {
            api.on('run.started', () => {
                log.push(`${name}:run.started`);
            });

            api.on('harness.dispose', () => {
                log.push(`${name}:harness.dispose`);
            });
        }
    });

    /** A plugin that declares its OWN `enabled` key with an explicit default. */
    const declaringPlugin = (name: string, log: string[], enabledDefault: boolean): HarnessPlugin => ({
        name,
        metadata: {
            name,
            title: name,
            builtin: true,
            settings: [
                { key: 'enabled', label: 'Enabled', type: 'boolean', default: enabledDefault }
            ]
        },
        setup: (api) => {
            api.on('run.started', () => {
                log.push(`${name}:run.started`);
            });

            api.on('harness.dispose', () => {
                log.push(`${name}:harness.dispose`);
            });
        }
    });

    it('delivers every hook to a plugin with nothing stored (the switch defaults on)', async () => {
        const log: string[] = [];
        const { hooks } = apply([plainPlugin('alpha', log)], []);

        expect(hooks.count('run.started')).toBe(1);

        await hooks.emit('run.started', runContext);
        hooks.fire('harness.dispose', {});

        expect(log).toEqual(['alpha:run.started', 'alpha:harness.dispose']);
    });

    it('stops delivering every gated event to a disabled plugin, and still delivers harness.dispose', async () => {
        const log: string[] = [];
        const { hooks, settings } = apply([plainPlugin('alpha', log)], []);

        // The write edge of the switch is a plain boolean override under the reserved key
        // (../server/plugins.ts); nothing was declared, so the framework's synthesized
        // descriptor is what makes this value meaningful.
        settings.set('alpha', 'enabled', false);

        await hooks.emit('run.started', runContext);
        await hooks.emit('run.started', runContext);

        // Not one delivery, and no error report either: an operator turning a plugin off is
        // not a handler failure (./hooks.ts rule 9).
        expect(log).toEqual([]);

        // Teardown is exempt, so a disabled plugin still releases its own timers and handles.
        hooks.fire('harness.dispose', {});

        expect(log).toEqual(['alpha:harness.dispose']);
    });

    it('honours a plugin that declares `enabled` with its own default of false', async () => {
        const log: string[] = [];
        const { hooks, settings, result } = apply([declaringPlugin('alpha', log, false)], []);

        // Declared default OFF => off from the first turn, with nothing else stored: the
        // plugin's own descriptor is the fallback the gate resolves, so a host with no
        // settings document at all still honours what the plugin published.
        expect(result.metadata[0].settings?.map((entry) => entry.key)).toEqual(['enabled']);
        await hooks.emit('run.started', runContext);
        expect(log).toEqual([]);

        // The plugin's own Rule-0 style read and the framework gate consult the SAME key, so
        // one stored `true` turns both on at once — and a reset (`undefined`/absent) lands
        // back on the plugin's declared false, not on the framework's `true`.
        settings.set('alpha', 'enabled', true);
        await hooks.emit('run.started', runContext);
        expect(log).toEqual(['alpha:run.started']);

        settings.set('alpha', 'enabled', false);
        await hooks.emit('run.started', runContext);
        expect(log).toEqual(['alpha:run.started']);
    });

    it('applies a flip made AFTER setup() on the very next emit, with no re-registration', async () => {
        const log: string[] = [];
        const { hooks, settings } = apply([plainPlugin('alpha', log)], []);

        await hooks.emit('run.started', runContext);
        expect(log).toEqual(['alpha:run.started']);

        // Off: the handler registration is untouched, only delivery stops.
        settings.set('alpha', 'enabled', false);
        await hooks.emit('run.started', runContext);
        expect(log).toEqual(['alpha:run.started']);
        expect(hooks.has('run.started')).toBe(false);
        expect(hooks.count('run.started')).toBe(0);

        // But the SUBSCRIBED surface is still reported, because the plugin is loaded and
        // its `live()` rows are a fact about what setup() registered (./hooks.ts rule 9).
        expect(hooks.live()['run.started']).toEqual(['alpha']);

        // On again: the same registration runs, and `has()` stops letting an emit site skip.
        settings.set('alpha', 'enabled', true);
        await hooks.emit('run.started', runContext);

        expect(log).toEqual(['alpha:run.started', 'alpha:run.started']);
        expect(hooks.has('run.started')).toBe(true);
        expect(hooks.count('run.started')).toBe(1);
    });

    it('gates a `*` observer per DELIVERED event, so it still sees harness.dispose', async () => {
        const log: string[] = [];
        const observer: HarnessPlugin = {
            name: 'audit',
            metadata: { name: 'audit', title: 'Audit', builtin: true },
            setup: (api) => {
                api.on('*', (context) => {
                    log.push(`audit:${context.event}`);
                });
            }
        };

        const { hooks, settings } = apply([observer], []);

        settings.set('audit', 'enabled', false);

        await hooks.emit('run.started', runContext);
        expect(log).toEqual([]);

        // The wildcard envelope carries the event, and the gate is applied at dispatch with
        // THAT event, which is why teardown is exempt for a `*` subscriber exactly as it is
        // for a named one.
        hooks.fire('harness.dispose', {});

        expect(log).toEqual(['audit:harness.dispose']);
    });

    it('leaves a host-level subscription (owner "harness") ungated', async () => {
        const log: string[] = [];
        const hooks = createHookBus();

        // A host `on` carries no `enabled` predicate at all, so no operator switch can
        // silence the host's own observers — only plugin registrations are gated.
        hooks.on('run.started', () => log.push('host'), { owner: 'harness' });

        await hooks.emit('run.started', runContext);

        expect(log).toEqual(['host']);
        expect(hooks.has('run.started')).toBe(true);
    });
});
