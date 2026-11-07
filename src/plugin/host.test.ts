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
// recorded lifecycle names.
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

    return { used, hooks, result };
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
