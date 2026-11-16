// The panel runtime (T5/R1): what the app shell paints through — mount/unmount of
// registered shell panels, session scoping with REAL teardown, deterministic order,
// and coexistence with the tool-panel pipeline.
//
// The disposal cases are the point of this file. A live panel is long-running code
// the shell does not know, so the contract is measured in effects: the listener is
// gone, the timer is gone, the subscription is released, the element is gone, and
// none of them run twice.
//
// The `board visibility` block is T5/R3: `PanelPaintInput.visibility` says which slots the
// reader can actually look at, and a hidden slot is SUSPENDED rather than unmounted — the
// instance keeps its element, its painted content and its state, and is told about the
// change EXACTLY once (the paint loop runs on every stream frame). The `the context
// contract` block pins the channel that ride is on: `PanelContextController.setVisibility`
// and `PanelContext.onVisibility` (./context.ts), including its change-only, disposed-inert,
// throwing-listener-isolated rules.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanelHost } from '../ui/panels';
import type { PanelHost, PanelMedia } from '../ui/panels';
import type { StreamSubscription } from '../stream';
import { clearPanelKinds, registerPanelKind } from './panel-kinds';
import type { PanelContext, PanelSubscribe, PanelSubscriptionSpec } from './context';
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

    // --- T5/R3: the board-visibility channel ---------------------------------
    // This is the seam `../main.ts` drives from `scratchRailVisible` through
    // ./runtime.ts: a phone drawer that shuts has to reach every card in the slot, once,
    // and must not have to. The cases below are the rules the runtime relies on — the
    // runtime cannot re-implement any of them, so they are pinned at the source.
    const bareContext = (): ReturnType<typeof createPanelContext> =>
        createPanelContext({
            id: 'tasks',
            slot: 'scratch',
            element: document.createElement('div'),
            sessionId: () => 's1'
        });

    it('publishes visibility on a CHANGE, and treats anything but false as visible', () => {
        const seen: boolean[] = [];
        const controller = bareContext();

        controller.context.onVisibility((visible) => seen.push(visible));

        // VISIBLE BY DEFAULT, and the default is not a delivery: a host that never
        // touches the seam leaves every panel exactly as it was before it existed.
        expect(controller.context.visible).toBe(true);
        controller.setVisibility(true);
        expect(seen).toEqual([]);

        controller.setVisibility(false);
        expect(seen).toEqual([false]);

        // A `paint` per stream frame, and the answer to "still hidden?" is a no-op the
        // panel should not have to run at all (./context.ts:341-367).
        controller.setVisibility(false);
        controller.setVisibility(false);
        expect(seen).toEqual([false]);

        controller.setVisibility(true);
        expect(seen).toEqual([false, true]);

        // `undefined` for a slot is the host saying "no opinion", not "suspend it".
        controller.setVisibility(false);
        controller.setVisibility(undefined as unknown as boolean);
        expect(seen).toEqual([false, true, false, true]);
        expect(controller.context.visible).toBe(true);
    });

    it('never replays the current value on registration: `visible` is the readable answer', () => {
        const seen: boolean[] = [];
        const controller = bareContext();
        const { context } = controller;

        controller.setVisibility(false);

        // A panel that registers mid-mount must be able to find out what state it is in
        // WITHOUT a synthetic callback: the value is a live getter, and the listener only
        // ever carries a transition.
        context.onVisibility((visible) => seen.push(visible));
        expect(seen).toEqual([]);
        expect(context.visible).toBe(false);

        context.onVisibility(() => {
            throw new Error('unused');
        });
        controller.setVisibility(true);
        expect(seen).toEqual([true]);
        expect(context.visible).toBe(true);
    });

    it('isolates a throwing visibility listener from the others', () => {
        const seen: string[] = [];
        const controller = bareContext();

        controller.context.onVisibility((visible) => {
            seen.push(`first:${visible}`);
            // One card whose hide handler blew up cannot strand its siblings — they would
            // keep a wake and a client for a board that is off screen.
            throw new Error('the task card threw on the way out');
        });
        controller.context.onVisibility((visible) => seen.push(`second:${visible}`));

        controller.setVisibility(false);
        expect(seen).toEqual(['first:false', 'second:false']);
        // The value is committed BEFORE the fan-out, so a throw cannot leave the slot
        // claiming the opposite of what its cards just did.
        expect(controller.context.visible).toBe(false);

        controller.setVisibility(true);
        expect(seen).toEqual(['first:false', 'second:false', 'first:true', 'second:true']);
    });

    it('unsubscribes one visibility listener without disturbing its sibling', () => {
        const seen: string[] = [];
        const controller = bareContext();

        const off = controller.context.onVisibility((visible) => seen.push(`first:${visible}`));
        controller.context.onVisibility((visible) => seen.push(`second:${visible}`));

        controller.setVisibility(false);
        expect(seen).toEqual(['first:false', 'second:false']);

        off();
        controller.setVisibility(true);
        expect(seen).toEqual(['first:false', 'second:false', 'second:true']);
    });

    it('lets a listener unsubscribe a sibling mid-delivery, for the next change only', () => {
        const seen: string[] = [];
        const controller = bareContext();

        let offSecond: (() => void) | undefined;

        controller.context.onVisibility((visible) => {
            seen.push(`first:${visible}`);
            // The fan-out is over a COPY of the set (./context.ts:359), so removing an
            // entry here cannot skip the next one in this round — a card that retires its
            // neighbour during the hide still gets THIS transition.
            offSecond?.();
        });
        offSecond = controller.context.onVisibility((visible) => seen.push(`second:${visible}`));

        controller.setVisibility(false);
        expect(seen).toEqual(['first:false', 'second:false']);

        controller.setVisibility(true);
        expect(seen).toEqual(['first:false', 'second:false', 'first:true']);
    });

    it('is inert for visibility after dispose: no delivery, and no late listener', () => {
        const seen: boolean[] = [];
        const controller = bareContext();
        const { context } = controller;

        controller.dispose();

        // A board that went off screen while this panel was being torn down has nobody
        // left to tell.
        controller.setVisibility(false);
        expect(seen).toEqual([]);
        // Disposal does not rewrite the slot's value — it only stops it moving.
        expect(context.visible).toBe(true);

        // A late answer that registers after the teardown leaves nothing behind.
        context.onVisibility((visible) => seen.push(visible));
        controller.setVisibility(false);
        expect(seen).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T5/R3 — board visibility: a hidden slot is a SUSPENSION, not an unmount
// ---------------------------------------------------------------------------

describe('board visibility', () => {
    // The probe records what its instance was TOLD, labelled `id#instance` so a delivery
    // to a dead instance can never be mistaken for one to the live one (the same
    // labelling discipline the session-scoping cases above use). `mount` reports the value
    // the callback itself saw, which is the runtime default: ./runtime.ts publishes the
    // slot's state AFTER `panel.mount()` returns, and that ordering is part of the contract.
    type ProbeLog = string[];

    const installProbe = (
        log: ProbeLog,
        options: { id?: string; slot?: 'scratch' | 'center'; title?: string } = {}
    ): PanelContext[] => {
        const contexts: PanelContext[] = [];
        let instances = 0;

        registerShellPanel({
            id: options.id ?? 'tasks',
            ...(options.slot === undefined ? {} : { slot: options.slot }),
            ...(options.title === undefined ? {} : { title: options.title }),
            mount: (context) => {
                instances += 1;
                const label = `${context.id}#${instances}`;

                contexts.push(context);
                log.push(`mount:${label}:${context.visible}`);
                context.onVisibility((visible) => log.push(`visibility:${label}:${visible}`));
                context.onDispose(() => log.push(`dispose:${label}`));

                // The "state" the rail contract says must survive a toggle: one node the
                // panel painted itself, checked for IDENTITY, not just for a matching string.
                const line = document.createElement('p');
                line.textContent = `state:${label}`;
                context.element.append(line);
            }
        });

        return contexts;
    };

    const extensionOf = (id: string): HTMLElement | null =>
        hosts.scratch.element.querySelector<HTMLElement>(`[data-panel-extension="${id}"]`);

    it('leaves every panel visible and silent when the paint carries no visibility map', () => {
        const log: ProbeLog = [];
        const contexts = installProbe(log);

        runtime.paint({ hosts, sessionId: 's1' });

        // The host that never passes the seam (every test above, and every other host) is
        // exactly the behaviour it had before it: no listener, no call, `visible` true.
        expect(log).toEqual(['mount:tasks#1:true']);
        expect(contexts[0]?.visible).toBe(true);
    });

    it('treats a map that omits the slot, and a slot mapped to undefined, as visible', () => {
        const log: ProbeLog = [];
        const contexts = installProbe(log);

        // Another slot named, this one not: the centre rail being off screen says nothing
        // about the board.
        runtime.paint({ hosts, sessionId: 's1', visibility: { center: false } });
        expect(log).toEqual(['mount:tasks#1:true']);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: undefined } });
        expect(log).toEqual(['mount:tasks#1:true']);
        expect(contexts[0]?.visible).toBe(true);
    });

    it('tells an instance born into a hidden slot, once, however many paints follow', () => {
        const log: ProbeLog = [];
        const contexts = installProbe(log);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });

        // The mount callback saw the default; the delivery landed the moment it returned.
        // This is the case that would otherwise leak a live panel into a closed drawer: a
        // panel mounted by the boot paint of a phone is BORN hidden, and has to hear so.
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false']);
        expect(contexts[0]?.visible).toBe(false);

        // The paint loop runs on every stream frame; three more paints for a slot that has
        // not moved cost the panel nothing.
        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });
        runtime.paint({ hosts, media: [], sessionId: 's1', visibility: { scratch: false } });
        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false']);
    });

    it('delivers a hidden → shown transition, and nothing for the paints in between', () => {
        const log: ProbeLog = [];
        const contexts = installProbe(log);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });
        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: true } });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'visibility:tasks#1:true']);
        expect(contexts[0]?.visible).toBe(true);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: true } });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'visibility:tasks#1:true']);
    });

    it('reads the map fresh on every paint: an omitted map means visible, and the change lands', () => {
        const log: ProbeLog = [];
        installProbe(log);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false']);

        // The state is not latched: a host that stops publishing the slot gets the default
        // back, and an instance that was told `false` is told the truth now.
        runtime.paint({ hosts, sessionId: 's1' });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'visibility:tasks#1:true']);
    });

    it('suspends a hidden slot: the instance, its element and its painted state all survive', () => {
        const log: ProbeLog = [];
        installProbe(log);

        runtime.paint({ hosts, sessionId: 's1' });

        const element = extensionOf('tasks');
        if (element === null) throw new Error('the panel was not mounted');

        const line = element.querySelector('p');

        expect(line?.textContent).toBe('state:tasks#1');

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });

        // THE POINT OF THE SEAM: hidden is not unmounted. The rails stay in the DOM by the
        // shell's own contract (./rail-toggle.test.ts), so their content and the panel's own
        // state have to come back exactly as the reader left them.
        expect(runtime.mountedIds()).toEqual(['tasks']);
        expect(hosts.scratch.extensionIds()).toEqual(['tasks']);
        expect(extensionOf('tasks')).toBe(element);
        expect(element.isConnected).toBe(true);
        expect(element.querySelector('p')).toBe(line);
        expect(line?.textContent).toBe('state:tasks#1');
        // One transition in, no teardown, no re-mount.
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false']);

        // ...and the way back is the SAME instance, not a rebuild.
        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: true } });

        expect(extensionOf('tasks')).toBe(element);
        expect(element.querySelector('p')).toBe(line);
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'visibility:tasks#1:true']);
    });

    it('publishes per slot: hiding the board says nothing about the centre rail', () => {
        const log: ProbeLog = [];

        installProbe(log, { id: 'tasks', slot: 'scratch' });
        installProbe(log, { id: 'summary', slot: 'center' });

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });

        // Only the board moved; the centre panel is never told a word, and keeps reading.
        // (Draw order is `order` then id — ./shell-panels.ts:183 — so `summary` mounts first.)
        expect(log).toEqual(['mount:summary#1:true', 'mount:tasks#1:true', 'visibility:tasks#1:false']);

        // Handing the sidebar back and taking the centre away are two independent signals,
        // delivered per instance in draw order: the centre card is hidden, the scratch card
        // is re-shown, each exactly once.
        runtime.paint({ hosts, sessionId: 's1', visibility: { center: false } });
        expect(log).toEqual([
            'mount:summary#1:true',
            'mount:tasks#1:true',
            'visibility:tasks#1:false',
            'visibility:summary#1:false',
            'visibility:tasks#1:true'
        ]);
    });

    it('tells nothing after an unmount, and a fresh host is born into the map it is given', () => {
        const log: ProbeLog = [];

        installProbe(log);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });

        // A slot whose host is not handed over IS an unmount (the opposite of a hide), and
        // the unmount itself is not a visibility delivery: the disposer runs, the listener
        // goes with its context, and nothing else is said.
        runtime.paint({ hosts: {}, sessionId: 's1' });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'dispose:tasks#1']);
        expect(runtime.mountedIds()).toEqual([]);

        // Shown again while nothing is mounted: no listener is left to tell, hidden or not.
        runtime.paint({ hosts: {}, sessionId: 's1', visibility: { scratch: true } });
        runtime.paint({ hosts: {}, sessionId: 's1', visibility: { scratch: false } });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'dispose:tasks#1']);

        // A page teardown clears the stashed slot states (./runtime.ts:325), so a fresh host
        // that hands over no map mounts VISIBLE and silent — and its own hide is a change
        // worth telling again. This is the observable consequence of that reset: `paint`
        // re-reads the map at the top of every call either way (./runtime.ts:235), so the
        // stash cannot leak a previous host's opinion into a new instance through any other path.
        runtime.disposeAll();
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'dispose:tasks#1']);

        runtime.paint({ hosts, sessionId: 's1' });
        expect(log).toEqual(['mount:tasks#1:true', 'visibility:tasks#1:false', 'dispose:tasks#1', 'mount:tasks#2:true']);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });
        expect(log).toEqual([
            'mount:tasks#1:true',
            'visibility:tasks#1:false',
            'dispose:tasks#1',
            'mount:tasks#2:true',
            'visibility:tasks#2:false'
        ]);
    });

    it('never tells a mount that threw, and does not retry it into a delivery', () => {
        const log: ProbeLog = [];

        registerShellPanel({
            id: 'broken',
            mount: (context) => {
                log.push(`mount:${context.id}:${context.visible}`);
                context.onVisibility((visible) => log.push(`visibility:${context.id}:${visible}`));

                throw new Error('no view for you');
            }
        });

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: false } });

        // The half-built instance was disposed before the slot state could be published to
        // it, so its listener has already been released with its context.
        expect(log).toEqual(['mount:broken:true']);
        expect(runtime.failures()).toEqual({ broken: 'no view for you' });
        expect(runtime.mountedIds()).toEqual([]);

        runtime.paint({ hosts, sessionId: 's1', visibility: { scratch: true } });
        expect(log).toEqual(['mount:broken:true']);
    });
});
