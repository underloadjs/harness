// The panel runtime (T5/R1): what the app shell paints through — mount/unmount of
// registered shell panels, session scoping with REAL teardown, deterministic order,
// and coexistence with the tool-panel pipeline.
//
// The disposal cases are the point of this file. A live panel is long-running code
// the shell does not know, so the contract is measured in effects: the listener is
// gone, the timer is gone, the subscription is released, the element is gone, and
// none of them run twice.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanelHost } from '../ui/panels';
import type { PanelHost, PanelMedia } from '../ui/panels';
import type { StreamSubscription } from '../stream';
import { clearPanelKinds, registerPanelKind } from './panel-kinds';
import type { PanelSubscribe, PanelSubscriptionSpec } from './context';
import { createPanelContext, panelApi } from './context';
import { clearShellPanels, registerShellPanel, unregisterShellPanel } from './shell-panels';
import { createPanelRuntime } from './runtime';
import type { PanelRuntime } from './runtime';

// The three hosts the shell mounts, attached so a removal is observable in the DOM.
type Hosts = Record<'scratch' | 'center' | 'left', PanelHost>;

const makeHosts = (): Hosts => {
    const hosts = {
        scratch: createPanelHost('scratch'),
        center: createPanelHost('center'),
        left: createPanelHost('left')
    };

    for (const host of Object.values(hosts)) document.body.append(host.element);

    return hosts;
};

// A subscription double: the runtime is what releases it, so the test needs to see
// the call and the spec the context built.
const useSubscriptions = (): {
    subscribe: PanelSubscribe;
    specs: PanelSubscriptionSpec[];
    released: string[];
} => {
    const specs: PanelSubscriptionSpec[] = [];
    const released: string[] = [];

    return {
        specs,
        released,
        subscribe: (spec) => {
            const id = `sub-${specs.length + 1}`;
            specs.push(spec);

            const subscription: StreamSubscription = {
                id,
                spec: { ...spec, scope: spec.scope },
                cursor: null,
                sequence: 0,
                unsubscribe: () => released.push(id)
            };

            return subscription;
        }
    };
};

const scratchHosts = (hosts: Hosts) => ({ scratch: hosts.scratch });

let hosts: Hosts;
let runtime: PanelRuntime;

beforeEach(() => {
    document.body.innerHTML = '';
    clearShellPanels();
    clearPanelKinds();
    hosts = makeHosts();
    runtime = createPanelRuntime();
});

afterEach(() => {
    runtime.disposeAll();
    clearShellPanels();
    clearPanelKinds();
    vi.useRealTimers();
});

describe('the empty registry', () => {
    it('paints the tool panels and nothing else', () => {
        registerPanelKind({ kind: 'unused', render: () => undefined });

        runtime.paint({ hosts, media: [], sessionId: 's1' });
        expect(hosts.scratch.element.innerHTML).toBe('');
        expect(hosts.scratch.element.hidden).toBe(true);
        expect(hosts.scratch.extensionIds()).toEqual([]);
        expect(document.querySelectorAll('.panel-extension')).toHaveLength(0);
        expect(runtime.mountedIds()).toEqual([]);
        expect(runtime.activeSessionId()).toBe('s1');
    });
});

describe('mounting', () => {
    it('mounts into the declared slot with the card chrome, around the tool panels', () => {
        registerShellPanel({
            id: 'tasks',
            title: 'Tasks',
            mount: (context) => {
                const line = document.createElement('p');
                line.textContent = `session:${context.sessionId ?? 'none'}`;
                context.element.append(line);
            }
        });

        const card: PanelMedia[] = (() => {
            const media = new Map<string, PanelMedia>();
            // The same upsert the shell uses for a `tool_result.ui` list.
            media.set('statusTool\u001fstatus', {
                key: 'statusTool\u001fstatus',
                slot: 'scratch',
                panel: {
                    id: 'status',
                    slot: 'scratch',
                    title: 'Status',
                    blocks: [{ type: 'text', text: 'ready' }]
                }
            });

            return [...media.values()];
        })();

        runtime.paint({ hosts, media: card, sessionId: 's1' });

        // Default `position: 'after'`: the tool card keeps the top of the board, so a
        // registered panel cannot disturb what the tool tests pin.
        expect(hosts.scratch.element.innerHTML).toBe(
            '<article class="panel" data-panel-id="status" data-panel-slot="scratch" data-panel-state="full" ' +
                'data-panel-tool="statusTool"><h3 class="panel-title">Status</h3>' +
                '<div class="panel-blocks"><p class="panel-text">ready</p></div></article>' +
                '<div class="panel panel-extension" data-panel-extension="tasks" data-panel-slot="scratch">' +
                '<h3 class="panel-title">Tasks</h3><p>session:s1</p></div>'
        );

        // The note's source (`ids()`) is still the tool list alone.
        expect(hosts.scratch.ids()).toEqual(['status']);
        expect(hosts.scratch.extensionIds()).toEqual(['tasks']);
        expect(hosts.center.element.innerHTML).toBe('');
        expect(runtime.mountedIds()).toEqual(['tasks']);
    });

    it('honours position: before and the deterministic order', () => {
        registerShellPanel({ id: 'zeta', order: 100, mount: (c) => void (c.element.textContent = 'z') });
        registerShellPanel({ id: 'alpha', order: 100, mount: (c) => void (c.element.textContent = 'a') });
        registerShellPanel({
            id: 'top',
            order: 0,
            position: 'before',
            mount: (c) => void (c.element.textContent = 't')
        });

        // A conversation must exist for a session-scoped panel to mount at all (the
        // `requiresSession` default) — see the gate cases below.
        runtime.paint({ hosts, sessionId: 's1' });

        expect([...hosts.scratch.element.children].map((node) => node.textContent)).toEqual(['t', 'a', 'z']);
        expect(hosts.scratch.extensionIds()).toEqual(['top', 'alpha', 'zeta']);
        expect(runtime.mountedIds()).toEqual(['top', 'alpha', 'zeta']);
    });

    it('keeps an instance mounted across paints, and never moves it on a tool repaint', () => {
        registerShellPanel({ id: 'tasks', title: 'Tasks', mount: () => {} });
        runtime.paint({ hosts, sessionId: 's1' });

        const first = hosts.scratch.element.querySelector<HTMLElement>('[data-panel-extension="tasks"]');
        if (first === null) throw new Error('the panel was not mounted');

        // Two tool repaints with different data: the live node stays THE SAME node at
        // the same index — no re-run of mount, no lost scroll position or focus.
        runtime.paint({ hosts, sessionId: 's1' });
        runtime.paint({
            hosts,
            sessionId: 's1',
            media: [
                {
                    key: 'tool\u001flive',
                    slot: 'scratch',
                    panel: { id: 'live', slot: 'scratch', title: '', blocks: [{ type: 'text', text: 'x' }] }
                }
            ]
        });

        const now = hosts.scratch.element.querySelector<HTMLElement>('[data-panel-extension="tasks"]');

        expect(now).toBe(first);
        expect(hosts.scratch.element.children[1]).toBe(now);
        expect(hosts.scratch.ids()).toEqual(['live']);
        expect(hosts.scratch.element.children[0]?.dataset.panelId).toBe('live');
    });

    it('leaves a slot unmounted until its host is handed over', () => {
        registerShellPanel({ id: 'summary', slot: 'center', title: 'Summary', mount: () => {} });

        runtime.paint({ hosts: scratchHosts(hosts), sessionId: 's1' });
        expect(runtime.mountedIds()).toEqual([]);
        expect(hosts.center.element.innerHTML).toBe('');

        runtime.paint({ hosts, sessionId: 's1' });
        expect(runtime.mountedIds()).toEqual(['summary']);
        expect(hosts.center.element.innerHTML).toBe(
            '<div class="panel panel-extension" data-panel-extension="summary" data-panel-slot="center">' +
                '<h3 class="panel-title">Summary</h3></div>'
        );
    });
});

describe('session scoping', () => {
    // The full set of resources a live panel plausibly holds, each released through a
    // DIFFERENT mechanism (signal, onDispose, subscription), and each labelled with
    // the INSTANCE that created it — so "no leak" is proven per instance, not by a
    // count the re-mount for the next session would blur.
    const leakyPanel = (log: string[]): void => {
        let instances = 0;

        registerShellPanel({
            id: 'tasks',
            title: 'Tasks',
            mount: (context) => {
                instances += 1;
                const self = instances;

                window.addEventListener('resize', () => log.push(`listener:${self}`), { signal: context.signal });

                const timer = window.setInterval(() => log.push(`tick:${self}`), 1_000);
                context.onDispose(() => {
                    window.clearInterval(timer);
                    log.push(`timer:${self}`);
                });

                context.onDispose(() => log.push(`second:${self}`));

                context.subscribe({ scope: 'session' });
                context.onDispose(() => log.push(`first:${self}`));
            }
        });
    };

    it('releases everything on a session switch, and re-mounts for the new session', () => {
        vi.useFakeTimers();

        const log: string[] = [];
        const stream = useSubscriptions();
        const runtimeScoped = createPanelRuntime({ subscribe: stream.subscribe });

        leakyPanel(log);
        runtimeScoped.paint({ hosts, sessionId: 's1' });

        const firstElement = hosts.scratch.element.querySelector('[data-panel-extension="tasks"]');
        expect(stream.specs).toEqual([{ scope: 'session', sessionId: 's1' }]);
        expect(vi.getTimerCount()).toBe(1);

        window.dispatchEvent(new Event('resize'));
        expect(log).toEqual(['listener:1']);

        runtimeScoped.paint({ hosts, sessionId: 's2' });

        // Reverse registration order, and the subscription released by the context —
        // not by a disposer the panel wrote.
        expect(log).toEqual(['listener:1', 'first:1', 'second:1', 'timer:1']);
        expect(stream.released).toEqual(['sub-1']);

        const nextElement = hosts.scratch.element.querySelector('[data-panel-extension="tasks"]');
        expect(nextElement).not.toBeNull();
        expect(nextElement).not.toBe(firstElement);
        expect(hosts.scratch.element.querySelectorAll('[data-panel-extension="tasks"]')).toHaveLength(1);

        // Exactly ONE listener is live afterwards: the abandoned instance's resize
        // callback is gone (its signal is aborted) while the new one answers. One
        // timer, not two, is the same proof for the interval.
        window.dispatchEvent(new Event('resize'));
        expect(log).toEqual(['listener:1', 'first:1', 'second:1', 'timer:1', 'listener:2']);
        expect(vi.getTimerCount()).toBe(1);

        runtimeScoped.disposeAll();
        expect(stream.released).toEqual(['sub-1', 'sub-2']);
        expect(vi.getTimerCount()).toBe(0);
        expect(log).toEqual([
            'listener:1',
            'first:1',
            'second:1',
            'timer:1',
            'listener:2',
            'first:2',
            'second:2',
            'timer:2'
        ]);
    });

    it('re-targets an app-scoped panel instead of disposing it', () => {
        const stream = useSubscriptions();
        const runtimeScoped = createPanelRuntime({ subscribe: stream.subscribe });
        const seen: (string | null)[] = [];
        let element: HTMLElement | undefined;

        registerShellPanel({
            id: 'rail',
            title: 'Rail',
            scope: 'app',
            mount: (context) => {
                element = context.element;
                context.onDispose(() => seen.push('disposed'));
                context.onSessionChange((sessionId) => seen.push(sessionId));
                seen.push(context.sessionId ?? 'none');
            }
        });

        runtimeScoped.paint({ hosts, sessionId: 's1' });
        runtimeScoped.paint({ hosts, sessionId: 's2' });
        runtimeScoped.paint({ hosts, sessionId: null });

        // No teardown, no re-create: the SAME element is still in place, and the panel
        // was told each time where the reader is.
        expect(seen).toEqual(['s1', 's2', null]);
        expect(hosts.scratch.element.querySelector('[data-panel-extension="rail"]')).toBe(element ?? null);
        expect(runtimeScoped.mountedIds()).toEqual(['rail']);
        expect(stream.released).toEqual([]);

        // Its live `sessionId` read follows the switch (a session-scoped panel never
        // gets the chance: it is disposed first).
        runtimeScoped.paint({ hosts, sessionId: 's3' });
        expect(seen).toEqual(['s1', 's2', null, 's3']);
    });

    it('holds a session-scoped panel back until a conversation exists, and mounts once', () => {
        const mounted: (string | null)[] = [];

        registerShellPanel({ id: 'tasks', title: 'Tasks', mount: (c) => void mounted.push(c.sessionId) });
        registerShellPanel({
            id: 'directory',
            title: 'Directory',
            // Conversation-independent AND app-scoped: the two declarations a global
            // panel needs, or the first session would rebuild it.
            requiresSession: false,
            scope: 'app',
            mount: (c) => void mounted.push(c.sessionId)
        });

        // The boot state: a harness is selected, the remembered conversation has not
        // been read yet. The live panel waits for a real session id to read with; the
        // app-level panel is free to mount now.
        runtime.paint({ hosts, sessionId: null });
        expect(mounted).toEqual([null]);
        expect(runtime.mountedIds()).toEqual(['directory']);

        // The conversation arrives: the waiting panel mounts EXACTLY once, and the
        // app-scoped one is neither disposed nor re-mounted.
        runtime.paint({ hosts, sessionId: 's1' });
        expect(mounted).toEqual([null, 's1']);
        expect(runtime.mountedIds()).toEqual(['directory', 'tasks']);

        runtime.disposeAll();
        expect(runtime.mountedIds()).toEqual([]);
        expect(mounted).toEqual([null, 's1']);
    });

    it('rebuilds a session-less live panel when a conversation arrives', () => {
        const stream = useSubscriptions();
        const runtimeScoped = createPanelRuntime({ subscribe: stream.subscribe });
        const mounted: string[] = [];

        registerShellPanel({
            id: 'board',
            title: 'Board',
            requiresSession: false,
            mount: (context) => {
                context.subscribe({ scope: 'global' });
                context.onDispose(() => mounted.push('disposed'));
            }
        });

        runtimeScoped.paint({ hosts, sessionId: null });
        expect(stream.specs).toEqual([{ scope: 'global', sessionId: undefined }]);

        runtimeScoped.paint({ hosts, sessionId: 's1' });

        // Session-scoped disposal still applies to a panel that was allowed to mount
        // without a conversation: its subscription was opened for the PREVIOUS state,
        // so it is released and the panel is rebuilt against the new one.
        expect(mounted).toEqual(['disposed']);
        expect(stream.specs).toEqual([
            { scope: 'global', sessionId: undefined },
            { scope: 'global', sessionId: 's1' }
        ]);
        expect(stream.released).toEqual(['sub-1']);
    });

    it('gates a panel per session, and a closed gate disposes it', () => {
        const log: string[] = [];

        registerShellPanel({
            id: 'tasks',
            title: 'Tasks',
            when: (sessionId) => sessionId !== null,
            mount: (context) => {
                context.onDispose(() => log.push('disposed'));
                context.element.textContent = 'live';
            }
        });

        runtime.paint({ hosts, sessionId: null });
        expect(runtime.mountedIds()).toEqual([]);
        expect(hosts.scratch.element.innerHTML).toBe('');

        runtime.paint({ hosts, sessionId: 's1' });
        expect(runtime.mountedIds()).toEqual(['tasks']);

        // New session (the id goes away) is a dispose, not a hide: an empty board must
        // not keep a conversation's subscriptions alive.
        runtime.paint({ hosts, sessionId: null });
        expect(log).toEqual(['disposed']);
        expect(hosts.scratch.element.innerHTML).toBe('');
        expect(hosts.scratch.element.hidden).toBe(true);
    });

    it('releases an instance the moment its registration leaves the registry', () => {
        const log: string[] = [];

        const teardown = registerShellPanel({
            id: 'tasks',
            mount: (context) => context.onDispose(() => log.push('disposed'))
        });

        runtime.paint({ hosts, sessionId: 's1' });
        expect(runtime.mountedIds()).toEqual(['tasks']);

        teardown();
        runtime.paint({ hosts, sessionId: 's1' });

        expect(log).toEqual(['disposed']);
        expect(runtime.mountedIds()).toEqual([]);
        expect(hosts.scratch.element.innerHTML).toBe('');

        // The same panel registered again is a FRESH instance: its own disposer is the
        // one that will run, and nothing from the disposed one is left attached.
        registerShellPanel({ id: 'tasks', mount: (context) => context.onDispose(() => log.push('again')) });
        runtime.paint({ hosts, sessionId: 's1' });
        expect(log).toEqual(['disposed']);
        expect(runtime.mountedIds()).toEqual(['tasks']);
        expect(hosts.scratch.element.innerHTML).toBe(
            '<div class="panel panel-extension" data-panel-extension="tasks" data-panel-slot="scratch"></div>'
        );

        runtime.disposeAll();
        expect(log).toEqual(['disposed', 'again']);

        // A page teardown releases INSTANCES, not registrations: the panel is still
        // declared, and a later paint (another host, another test) mounts it again.
        expect(unregisterShellPanel('tasks')).toBe(true);
    });
});

describe('failure isolation', () => {
    it('drops the panel that threw, keeps the others, and does not retry until re-registered', () => {
        const mounted: string[] = [];

        registerShellPanel({ id: 'a', mount: (context) => void mounted.push(`a:${context.sessionId ?? 'none'}`) });
        registerShellPanel({
            id: 'broken',
            order: 50,
            mount: () => {
                throw new Error('no view for you');
            }
        });
        registerShellPanel({ id: 'z', mount: () => void mounted.push('z') });

        runtime.paint({ hosts, sessionId: 's1' });

        expect(mounted).toEqual(['a:s1', 'z']);
        expect(runtime.failures()).toEqual({ broken: 'no view for you' });
        expect(hosts.scratch.element.innerHTML).toBe(
            '<div class="panel panel-extension" data-panel-extension="a" data-panel-slot="scratch"></div>' +
                '<div class="panel panel-extension" data-panel-extension="z" data-panel-slot="scratch"></div>'
        );

        // A second paint costs nothing: the failure is remembered, so the paint loop
        // cannot spin on a broken plugin.
        runtime.paint({ hosts, sessionId: 's1' });
        expect(mounted).toEqual(['a:s1', 'z']);
        expect(runtime.mountedIds()).toEqual(['a', 'z']);

        // Re-registering is the fix the author reaches for, and it is honoured.
        registerShellPanel({ id: 'broken', order: 50, mount: () => void mounted.push('broken') });
        runtime.paint({ hosts, sessionId: 's1' });
        expect(mounted).toEqual(['a:s1', 'z', 'broken']);
        expect(runtime.failures()).toEqual({});
        // `broken` has the lower order, so it now leads the board — the mount LOG order
        // is mount EXECUTION (a, z first, then the retry), the DRAW order is the
        // registry's, which is what the host shows.
        expect(runtime.mountedIds()).toEqual(['broken', 'a', 'z']);
        expect(
            [...hosts.scratch.element.children].map((node) => node.getAttribute('data-panel-extension'))
        ).toEqual(['broken', 'a', 'z']);
    });
});

describe('the context contract', () => {
    it('hands the shell API client by default and an injected one on request', () => {
        const seen: string[] = [];

        registerShellPanel({ id: 'a', mount: (context) => void seen.push(typeof context.api.readSession) });
        runtime.paint({ hosts, sessionId: 's1' });
        expect(seen).toEqual(['function']);

        // A host may replace any member of the surface. The runtime MERGES the injected
        // object over the shell's own client (./context.ts) — a host that supplies one
        // read keeps the other twelve — and never calls it, so this double needs no
        // members beyond the one it overrides.
        const api = { readSession: () => Promise.resolve({}) };
        const injected = createPanelRuntime({ api });

        clearShellPanels();
        registerShellPanel({
            id: 'a',
            mount: (context) => {
                seen.push(String(context.api.readSession === api.readSession));
                seen.push(String(context.api.url === panelApi.url));
            }
        });
        injected.paint({ hosts, sessionId: 's1' });

        expect(seen).toEqual(['function', 'true', 'true']);
        injected.disposeAll();
    });

    it('is inert after dispose: a late subscribe is dropped, a late disposer runs now', () => {
        const stream = useSubscriptions();
        const controller = createPanelContext({
            id: 'tasks',
            slot: 'scratch',
            element: document.createElement('div'),
            sessionId: () => 's1',
            subscribe: stream.subscribe
        });

        expect(controller.context.sessionId).toBe('s1');
        expect(controller.context.disposed).toBe(false);

        controller.dispose();

        expect(controller.context.disposed).toBe(true);
        expect(controller.context.subscribe({ scope: 'session' })).toBeUndefined();
        expect(stream.specs).toEqual([]);

        const late: string[] = [];
        controller.context.onDispose(() => late.push('immediate'));
        expect(late).toEqual(['immediate']);

        // Disposing twice changes nothing.
        controller.dispose();
        expect(stream.released).toEqual([]);
    });

    it('rewrites and removes its own heading', () => {
        const element = document.createElement('div');
        const controller = createPanelContext({
            id: 'tasks',
            slot: 'scratch',
            element,
            sessionId: () => 's1',
            title: 'Tasks'
        });

        expect(element.innerHTML).toBe('<h3 class="panel-title">Tasks</h3>');
        controller.context.setTitle('Tasks · 3 open');
        expect(element.innerHTML).toBe('<h3 class="panel-title">Tasks · 3 open</h3>');

        // A panel that replaces its children can ask for the heading back.
        element.replaceChildren();
        controller.context.setTitle('Tasks');
        expect(element.innerHTML).toBe('<h3 class="panel-title">Tasks</h3>');

        controller.context.setTitle('');
        expect(element.innerHTML).toBe('');
    });

    it('removes one disposer without disposing the panel', () => {
        const log: string[] = [];
        const controller = createPanelContext({
            id: 'tasks',
            slot: 'scratch',
            element: document.createElement('div'),
            sessionId: () => 's1'
        });

        const off = controller.context.onDispose(() => log.push('kept'));
        controller.context.onDispose(() => log.push('dropped'));
        off();

        controller.dispose();
        expect(log).toEqual(['dropped']);
    });
});
