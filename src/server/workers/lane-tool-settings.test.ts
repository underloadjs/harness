// R3 (the two DEPLOYMENT-WIDE switches) x worker lanes: the deny list and the plugin
// overrides reach a lane worker as DATA.
//
// R4 moved ONE of the two switches down a scope, and these lane claims are what that move has to
// keep true: the tool deny list is still process-wide (../tool-settings.ts), while the plugin
// overrides are now THIS SESSION's own map - `blueprintFor` reads `session.plugins.snapshot()`,
// and the write that a lane can ever see is the session-scoped one
// (`store.updateSessionPluginSettings`, ../sessions.ts). A TEMPLATE plugin write therefore
// reaches no lane that already exists; it seeds a session created AFTER it, and that split is
// pinned in the plugin-blueprint describe below.
//
// WHY THIS FILE EXISTS
// --------------------
// The coordinator hands every harness the settings providers LIVE (../sessions.ts
// `buildHarness` -> `HarnessPresetReport.toolSettings` / `.pluginSettings` ->
// ../harnesses/toolbox.ts -> `HarnessConfiguration`) - the TOOL provider from the process store,
// the PLUGIN provider from the SESSION's own store (R4) - and the runtime re-reads them per
// decision: src/harness.ts at three tool decisions (declarations, the launch gate, discovery)
// and src/plugin/host.ts + hooks.ts at every hook delivery (`settings.boolean('enabled',
// true)`). A CLOSURE cannot cross `worker_threads`, so a lane replica used to be built with
// NOTHING disabled and every plugin at its shipped default: the operator's switches applied
// to inline sessions and silently not to a CPU-isolated one.
//
// The fix is the mechanism every other lane-creation value already uses (the `hello`
// blueprint's `record`/`settings`/`apiKey`/`memoryKeys`): serialise the VALUES at lane
// creation and rebuild the providers inside the worker. One describe per link in that chain,
// for each switch:
//
//   1. THE BLUEPRINT - the store states both values in the data it hands the host at lane
//      creation (./lane-host.ts merges them into `LaneBlueprint` verbatim), the deny list from
//      the process store and the plugin map from that SESSION's own store, as plain
//      structured-cloneable data (the wire rule), and a value captured at creation does not
//      move when the operator edits either store afterwards - the documented lane semantics.
//   2. THE PROVIDER  - the worker's two builders turn the snapshots back into a
//      `HarnessToolSettingsProvider` / a `HarnessPluginSettingsProvider`, answer per name and
//      per plugin+key, stay SNAPSHOTS (a later mutation of the shipped map cannot move this
//      lane's answer mid-turn), and yield `undefined` for an empty/absent snapshot so a lane
//      with nothing switched off keeps the library's own declared-default providers.
//   3. THE HARNESS   - a harness built EXACTLY the way the lane builds one
//      (`presetFromRecord(record).create(settings, progress, report)`, the call
//      ./lane-worker-loop.ts `sayHello` makes) consults them: the disabled tool name is
//      refused, its neighbours are not, and a plugin switched off stops at its Rule 0 while
//      one switched on consults its whole policy.
//   4. THE THREAD    - real `node:worker_threads` lanes where the value is read off the WIRE:
//      the tool list and the message list a stub provider receives are the replica's own
//      declarations and its own plugin-pass decision.
//
// WHAT THIS FILE DOES NOT CLAIM
// -----------------------------
// That the library honours a provider at all (src/harness.tool-settings.test.ts pins that),
// and that a lane worker rebuilds, runs and commits a turn (./lane-worker.test.ts,
// ./lane-worker-correctness.test.ts). Level 3 is the WIRING claim: the value in the blueprint
// reaches `HarnessConfiguration` and is consulted by the decisions that read it - the tool
// switch at a tool decision, the plugin switch at the framework's hook gate.
//
// Why the deep tests run on the FLAKY preset: its factory IS `createToolboxHarness`, the
// shared toolbox every live preset and every live lane is built from, AND it has a live
// transport - so the request the replica sends arrives at a loopback stub as BYTES, which is
// where a declaration list and a plugin's context decision stop being internal state. The
// scripted `demo` fixture builds its own `harness({...})` and had to be taught to forward
// `toolSettings`/`pluginSettings` at all (../harnesses/fixture-presets.test-support.ts), so its
// INLINE half is pinned separately below. Its LANE half is proven on `flaky` instead: a scripted
// factory is a closure over a stream function, and the worker rebuilds a harness with
// `presetFromRecord(blueprint.record)` - no fallback object can cross `worker_threads` - so a
// scripted session is refused on a lane by construction (./provider-stub.test-support.ts).
//
// Cross-references:
//   - ./protocol.ts                   `LaneBlueprint.disabledTools` / `.pluginSettings`
//   - ./lane-host.ts                  `LaneBlueprintSource` + the `{...blueprintSource}` merge
//   - ./lane-worker-loop.ts           `laneToolSettingsProvider`, `lanePluginSettingsProvider`,
//                                     `sayHello`'s create call
//   - ../sessions.ts                  `blueprintFor` (the read at lane creation), `buildHarness`,
//                                     `updatePluginSettings` (TEMPLATE scope) and
//                                     `updateSessionPluginSettings` (ONE session's store, R4)
//   - ../tool-settings.ts, ../plugins.ts the two stores these snapshots come from
//   - ../harnesses/presets.ts         the demo factory's two forwards
//   - ../../harness.ts                `isToolGloballyDisabled`, `requestToolsFor`
//   - ../../plugin/host.ts, plugin/hooks.ts the `enabled` gate a plugin provider answers
//   - ../harness.swagger.yaml, PATCH /v1/harness/plugins/{plugin_id} the lane-creation wording these fields implement

// The deepest level this feature can be pinned at, on REAL `node:worker_threads` lanes:
// a live turn whose provider request is captured on the WIRE by a loopback stub provider.
// The request body IS the replica's `declared()` output, so "absent from a worker-lane
// session's request toolset" is asserted on the bytes the model was actually given - no
// internal read, no mock. It costs a cold lane (~2-4 s) and one model request.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createHarnessRegistry, presetFromRecord } from '../harnesses';
import { presetToRecord } from '../harnesses/registry';
import { PRODUCTION_WITH_FIXTURES } from '../harnesses/fixture-presets.test-support';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import { SessionStore } from '../sessions';
import type { HarnessPluginSettingsProvider } from '../../types';
import type { RunnerSettings } from '../harnesses/types';
import type { SessionTurn } from '../protocol';
import type { LaneBlueprintSource } from './lane-host';
import { lanePluginSettingsProvider, laneToolSettingsProvider } from './lane-worker-loop';

// Worker mode is the deployment under test, and `blueprintFor` is only ever consumed by a
// lane, so an inline store would assert a path no worker reads. Nothing is dispatched here,
// so no thread is spawned (the host is created lazily on the first worker-mode dispatch,
// ../sessions.ts `lanes()`) while the capability gate that DOES run at `create` is the one a
// real lane passes.
const WORKER_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker'
};

const SETTINGS: RunnerSettings = { baseURL: 'http://localhost:9/v1', apiKey: 'test-key', model: 'test/model' };

const stores: SessionStore[] = [];

const storeOf = (): SessionStore => {
    const store = new SessionStore(SETTINGS, createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never), undefined, {
        runtime: WORKER_RUNTIME
    });

    stores.push(store);

    return store;
};

afterAll(() => {
    for (const store of stores) store.dispose();
});

// `blueprintFor` is PRIVATE because the lane host is its only caller; the store's own worker
// tests reach into the store the same way (./lane-worker.test.ts reads the private `host`).
// `liveSession` returns the very `Session` object the method takes, so the cast is on the
// member, never on the data.
const blueprintOf = (store: SessionStore, sessionId: string): LaneBlueprintSource =>
    (store as unknown as { blueprintFor: (session: ReturnType<SessionStore['liveSession']>) => LaneBlueprintSource }).blueprintFor(
        store.liveSession(sessionId)
    );

describe('R3 lane propagation: the blueprint carries the deny list at lane creation', () => {
    it('states the disabled names sorted and cloneable, next to the fields it joined', async () => {
        const store = storeOf();
        const session = await store.create('demo');

        // Nothing switched off is an EMPTY list, not an absent field: the worker reads both
        // identically, and the store always states the current set.
        expect(blueprintOf(store, session.id).disabledTools).toEqual([]);

        await store.updateToolEnabled('timeNow', false);

        expect(blueprintOf(store, session.id).disabledTools).toEqual(['timeNow']);

        // Sorted in the store's own order (../tool-settings.ts `disabled`), whatever the
        // write order was - this is the list the worker's Set is built from.
        await store.updateToolEnabled('textCount', false);
        await store.updateToolEnabled('browserLike', false);

        const blueprint = blueprintOf(store, session.id);

        expect(blueprint.disabledTools).toEqual(['browserLike', 'textCount', 'timeNow']);
        // THE WIRE RULE (./protocol.ts): every frame is structured-cloneable data. A Set, a
        // function, or any other live object here would throw at the thread boundary instead
        // of shipping, and every lane integration test in this folder would fail to hand-shake.
        expect(structuredClone(blueprint.disabledTools)).toEqual(['browserLike', 'textCount', 'timeNow']);

        // The blueprint's SHAPE: the two deployment-wide snapshots joined the lane-creation
        // fields and pushed nothing off. `snapshot` and `identities` are the HOST's own
        // (./lane-host.ts `spawn`), so they are not part of what the store supplies.
        expect(Object.keys(blueprint).sort()).toEqual([
            'apiKey',
            'disabledTools',
            'memoryKeys',
            'pluginSettings',
            'record',
            'settings'
        ]);

        // One source of truth: the SAME set the durable document carries (the store's
        // `snapshot()`), unwrapped for the wire, so a lane can never be told a different list
        // than `state.json` records.
        expect(blueprint.disabledTools).toEqual(store.toolSettings.snapshot().disabled ?? []);
    });

    it('is a lane-creation snapshot: an edit reaches the NEXT blueprint, not the one in hand', async () => {        const store = storeOf();
        const session = await store.create('demo');

        const created = blueprintOf(store, session.id);

        await store.updateToolEnabled('timeNow', false);

        const next = blueprintOf(store, session.id);

        // The value the FIRST lane was built with is untouched: a live lane keeps the state it
        // was created with, and picks the new value up when its lane is next created - the
        // documented semantics of every value that crosses here
        // (../harness.swagger.yaml, PATCH /v1/harness/plugins/{plugin_id}, `PATCH /v1/harness/plugins/{plugin_id}`).
        expect(created.disabledTools).toEqual([]);
        // A lane created after the write states the operator's current value.
        expect(next.disabledTools).toEqual(['timeNow']);

        // Back on, and the next lane declares it again: the switch never unregistered it.
        await store.updateToolEnabled('timeNow', true);

        expect(blueprintOf(store, session.id).disabledTools).toEqual([]);
        expect(created.disabledTools).toEqual([]);
    });
});

describe('R3 lane propagation: the worker turns the snapshot back into a provider', () => {
    it('answers exactly the names it was handed, and nothing else', () => {
        const provider = laneToolSettingsProvider(['timeNow', 'textCount']);

        expect(provider).toBeDefined();
        // The whole contract `src/harness.ts` calls: one predicate, no other member.
        expect(Object.keys(provider as object)).toEqual(['isToolDisabled']);
        expect(provider?.isToolDisabled('timeNow')).toBe(true);
        expect(provider?.isToolDisabled('textCount')).toBe(true);
        expect(provider?.isToolDisabled('time')).toBe(false);
        expect(provider?.isToolDisabled('noteSearch')).toBe(false);
        expect(provider?.isToolDisabled('')).toBe(false);
    });

    it('keeps the core fast path for an empty or absent list', () => {
        // `undefined` IS the provider-less shape: `declared()` returns the list as built when
        // no provider is wired (src/harness.ts), so a lane with nothing switched off builds
        // byte-identically to the pre-R3 replica, and an empty snapshot and an absent field
        // mean the same thing rather than two shapes on the wire.
        expect(laneToolSettingsProvider([])).toBeUndefined();
        expect(laneToolSettingsProvider(undefined)).toBeUndefined();
    });

    it('is a snapshot, not a view of the shipped array', () => {
        const disabledTools = ['timeNow'];
        const provider = laneToolSettingsProvider(disabledTools);

        // The worker's own copy: anything that mutates the array after the fact (a caller, a
        // future refactor of `sayHello`) cannot move this lane's answer mid-run.
        disabledTools.push('textCount');
        disabledTools[0] = 'noteSearch';

        expect(provider?.isToolDisabled('timeNow')).toBe(true);
        expect(provider?.isToolDisabled('noteSearch')).toBe(false);
        expect(provider?.isToolDisabled('textCount')).toBe(false);
    });
});

describe('R3 lane propagation: the blueprint carries the plugin overrides at lane creation', () => {
    it('states the override map in the shape state.json stores it, beside the deny list', async () => {
        const store = storeOf();
        const session = await store.create('demo');

        // "This session has never changed a plugin setting" is an EMPTY map, the same fact the
        // session's own block in the durable document expresses by omitting the field
        // (../persistence.ts `HarnessSessionRecord.pluginSettings`), and the worker reads it as
        // "install no provider".
        expect(blueprintOf(store, session.id).pluginSettings).toEqual({});

        // R4 SCOPE: `blueprintFor` reads `session.plugins.snapshot()` (../sessions.ts), the
        // SESSION's own store, so the write that a lane can see is the session-scoped one
        // (`store.updateSessionPluginSettings`, the twin of `PATCH /sessions/{id}/plugins/{id}`).
        // A TEMPLATE write (`store.updatePluginSettings`) leaves this blueprint empty - the
        // companion case below pins both halves of that split.
        await store.updateSessionPluginSettings(session.id, 'context-trimmer', { enabled: false });

        expect(blueprintOf(store, session.id).pluginSettings).toEqual({ 'context-trimmer': { enabled: false } });

        // A non-boolean knob crosses too - the plugin gate is not the only value a replica
        // used to answer with its shipped default - and the map keeps catalogue order.
        await store.updateSessionPluginSettings(session.id, 'context-compaction', { contextLimit: 4096, minTokens: 0 });

        const blueprint = blueprintOf(store, session.id);

        expect(blueprint.pluginSettings).toEqual({
            'context-compaction': { contextLimit: 4096, minTokens: 0 },
            'context-trimmer': { enabled: false }
        });
        // One source of truth: the SAME map this session's durable block carries (../sessions.ts
        // `sessionRecord` writes `session.plugins.snapshot()`), and every value is a JSON scalar,
        // so the frame is structured-cloneable data.
        expect(blueprint.pluginSettings).toEqual(store.liveSession(session.id).plugins.snapshot());
        expect(structuredClone(blueprint.pluginSettings)).toEqual({
            'context-compaction': { contextLimit: 4096, minTokens: 0 },
            'context-trimmer': { enabled: false }
        });

        // A reset drops the key, so the next lane answers that plugin's declared default.
        await store.updateSessionPluginSettings(session.id, 'context-trimmer', { enabled: null });

        expect(blueprintOf(store, session.id).pluginSettings).toEqual({
            'context-compaction': { contextLimit: 4096, minTokens: 0 }
        });

        // The other half of the split: none of the above is a TEMPLATE value, so the process
        // store this runtime seeds new sessions from is still empty. `disabledTools` above keeps
        // reading that process store - the deny list is deployment-wide by its own contract
        // (../tool-settings.ts), and only plugin settings moved per session.
        expect(store.pluginSettings.snapshot()).toEqual({});
    });

    it('is a lane-creation snapshot for the plugin values as well, and a template write moves only a later session', async () => {
        const store = storeOf();
        const session = await store.create('demo');

        const created = blueprintOf(store, session.id);

        await store.updateSessionPluginSettings(session.id, 'async-ping', { enabled: false });

        // The value the FIRST lane was built with is untouched: a live lane keeps the state it
        // was created with, and picks the new value up when its lane is next created.
        expect(created.pluginSettings).toEqual({});
        // A lane created after the write states this session's current value.
        expect(blueprintOf(store, session.id).pluginSettings).toEqual({ 'async-ping': { enabled: false } });

        // R4 SCOPE, both halves, in one case: a TEMPLATE write reaches neither the blueprint in
        // hand nor this session's own store...
        await store.updatePluginSettings('context-trimmer', { enabled: false });

        expect(created.pluginSettings).toEqual({});
        expect(blueprintOf(store, session.id).pluginSettings).toEqual({ 'async-ping': { enabled: false } });
        expect(store.liveSession(session.id).plugins.snapshot()).toEqual({ 'async-ping': { enabled: false } });

        // ...while a session created AFTER it is seeded from the template, and the lane built
        // from that session carries the template's value and none of the first session's.
        const later = await store.create('demo');

        expect(store.liveSession(later.id).plugins.snapshot()).toEqual({ 'context-trimmer': { enabled: false } });
        expect(blueprintOf(store, later.id).pluginSettings).toEqual({ 'context-trimmer': { enabled: false } });
    });
});

describe('R3 lane propagation: the worker turns the plugin snapshot into a provider', () => {
    it('answers the stored override per plugin and key, and nothing else', () => {
        const provider = lanePluginSettingsProvider({
            'context-trimmer': { enabled: false },
            'context-compaction': { contextLimit: 4096, mode: 'exclude' }
        });

        expect(provider).toBeDefined();
        // The contract `src/harness.ts` hands the plugin host: a `get`, and NO `set` - a
        // lane cannot write the host's document, so `api.settings.setOwn` gets the library's
        // stated "read-only (no writer)" refusal instead of a private copy nobody will read.
        expect(Object.keys(provider as object)).toEqual(['get']);

        expect(provider?.get('context-trimmer', 'enabled')).toBe(false);
        expect(provider?.get('context-compaction', 'contextLimit')).toBe(4096);
        expect(provider?.get('context-compaction', 'mode')).toBe('exclude');
        // A key nobody stored answers `undefined`, which is what makes the plugin view fall
        // through to the DECLARED default (src/plugin/settings.ts `resolve`) - the same answer
        // the host's own provider gives, because it is an override map too.
        expect(provider?.get('context-compaction', 'minTokens')).toBeUndefined();
        expect(provider?.get('async-ping', 'enabled')).toBeUndefined();
        expect(provider?.get('no-such-plugin', 'enabled')).toBeUndefined();
        // OWN-key discipline: a plugin named after an Object.prototype member must not read
        // through the prototype and report a value nobody stored.
        expect(provider?.get('constructor', 'enabled')).toBeUndefined();
        expect(provider?.get('toString', 'enabled')).toBeUndefined();
    });

    it('installs no provider when the operator never touched a switch', () => {
        // `{}` and an absent field both mean "no override exists", and the honest answer is
        // the library's own declared-default provider (src/harness.ts:1395) - which also keeps
        // the legacy `wakeIntervalMs` seed working for a host that uses that field.
        expect(lanePluginSettingsProvider({})).toBeUndefined();
        expect(lanePluginSettingsProvider(undefined)).toBeUndefined();
    });

    it('is a snapshot, not a view of the shipped map', () => {
        const pluginSettings = { 'context-trimmer': { enabled: false } };
        const provider = lanePluginSettingsProvider(pluginSettings);

        // The blueprint's map (and the inner per-plugin map) is COPIED, so a later writer -
        // a store snapshot rebuilt for another lane, a test helper - cannot move this lane's
        // answer between two hook deliveries of one run.
        pluginSettings['context-trimmer'].enabled = true;

        expect(provider?.get('context-trimmer', 'enabled')).toBe(false);
    });
});

describe('R3 lane propagation: the harness the lane builds consults the snapshot', () => {
    // The flaky fixture carries `template: 'flaky'`, so `presetFromRecord` rebuilds its
    // factory, and that factory is `createToolboxHarness` - the one place a report's
    // `toolSettings` becomes `HarnessConfiguration.toolSettings` (../harnesses/toolbox.ts).
    const flakyRecord = (): ReturnType<typeof presetToRecord> => {
        const preset = createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never).find('flaky');

        if (preset === undefined) throw new Error('The flaky fixture preset is not shipped in this build.');

        return presetToRecord(preset);
    };

    // The exact call shape of ./lane-worker-loop.ts `sayHello`: the rebuilt factory, the
    // blueprint's settings, the progress relay, and the report whose `toolSettings` member
    // this feature installs from `blueprint.disabledTools`.
    const replicaOf = (disabledTools?: string[]) => {
        const toolSettings = laneToolSettingsProvider(disabledTools);

        return presetFromRecord(flakyRecord()).create(SETTINGS, () => undefined, {
            ...(toolSettings === undefined ? {} : { toolSettings })
        });
    };

    // Discovery is the provider decision a replica answers by itself in this harness (the
    // routed door is installed only by `installAuthorityRuntime`, and `requestToolsFor` is
    // synchronous, src/harness.ts:3314). The exact envelopes below are the R3 contract that
    // file already pins inline; here they are the observable that the blueprint's value
    // actually reached the harness configuration.
    const ask = (replica: ReturnType<typeof replicaOf>, names: string[]): Record<string, unknown> =>
        replica.runtime.requestTools(undefined, { names }) as Record<string, unknown>;

    it('refuses the name the snapshot disables, with the switch reason', () => {
        const fresh = replicaOf([]);
        const lane = replicaOf(['timeNow']);

        // A harness built with NO deny list: the historical answer, and the name enabled.
        // Captured BEFORE the disabled one asks, so the pair is one comparison of one state.
        expect(ask(fresh, ['timeNow'])).toEqual({
            enabled: ['timeNow'],
            tools: [
                {
                    name: 'timeNow',
                    description:
                        'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
                    tags: ['time', 'clock', 'date']
                }
            ],
            matched: 1,
            omitted: 0
        });
        expect(fresh.discoveredTools).toEqual(['timeNow']);

        // The same request on a lane whose blueprint carried `timeNow`: an explicit refusal
        // (never `enabled: []` dressed up as a miss), and NOTHING written into the enabled
        // set, which is what keeps one lane's search from undoing the operator's decision.
        expect(ask(lane, ['timeNow'])).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'timeNow',
                    reason:
                        'Tool "timeNow" is disabled on this server by the operator. Requesting it again will not change this answer — adapt to the available tools or report the limitation.',
                    allowed: []
                }
            ]
        });
        expect(lane.discoveredTools).toEqual([]);
    });

    it('refuses per name: a snapshot with one entry leaves its neighbours enabled', () => {
        const lane = replicaOf(['timeNow']);

        // One request, one match permitted: the switch is a per-name deny list, not a
        // lane-wide "tools off", and the two answers arrive in the same envelope.
        expect(ask(lane, ['textCount', 'timeNow'])).toEqual({
            enabled: ['textCount'],
            tools: [
                {
                    name: 'textCount',
                    description:
                        'Count the words and characters in a text. Useful before claiming a length. Characters are UTF-16 code units (JavaScript string length), so characters outside the basic plane, such as many emoji, count as two.',
                    tags: ['text', 'words', 'count']
                }
            ],
            matched: 2,
            omitted: 0,
            forbidden: [
                {
                    name: 'timeNow',
                    reason:
                        'Tool "timeNow" is disabled on this server by the operator. Requesting it again will not change this answer — adapt to the available tools or report the limitation.',
                    allowed: []
                }
            ]
        });
        expect(lane.discoveredTools).toEqual(['textCount']);
    });
});

// ---------------------------------------------------------------------------
// The scripted `demo` preset: the one factory that used to DROP both switches.
// ---------------------------------------------------------------------------

describe('R3 parity: the scripted demo factory forwards both deployment-wide switches', () => {
    // The fixture's factory builds the harness directly (../harnesses/fixture-presets.ts
    // support), so it is the one preset whose own forwarding has to be pinned: until it
    // forwarded `report.toolSettings`/`report.pluginSettings`, a demo session ignored the
    // operator's switches entirely. `fallback` is load-bearing here: a scripted record cannot
    // be rebuilt from durable data alone in a build that ships no scripted preset, so the
    // registry's current entry for that name IS the factory (../harnesses/registry.ts).
    const demoReplica = (report: { toolSettings?: ReturnType<typeof laneToolSettingsProvider>; pluginSettings?: HarnessPluginSettingsProvider }) => {
        const preset = createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never).find('demo');

        if (preset === undefined) throw new Error('The scripted demo preset is not shipped in this build.');

        return presetFromRecord(presetToRecord(preset), preset).create(SETTINGS, () => undefined, report);
    };

    it('refuses a globally disabled tool inside a demo run, and runs it otherwise', async () => {
        const switched = await demoReplica({ toolSettings: laneToolSettingsProvider(['timeNow']) })('what time is it?');

        // The scripted transport asks for `timeNow` by name whatever the declarations say, so
        // this is the launch-gate half of the switch reaching the preset that used to ignore
        // it. The demo's own closing line quotes the tool result, so the refusal is readable
        // verbatim in the answer - the exact sentence src/harness.ts owns.
        expect(switched.content).toBe(
            'timeNow returned Tool "timeNow" is disabled on this server by the operator.. That is the whole loop: ' +
                'the harness ran the tool, appended its result, and re-requested until the model answered with text. ' +
                'Switch to a live preset and set an endpoint to try this against a real model.'
        );

        const plain = await demoReplica({})('what time is it?');

        // The control is the shipped demo: `timeNow` EXECUTED, so the answer quotes its
        // `{ timezone, iso, unix }` payload rather than a refusal.
        expect(plain.content).toContain('timeNow returned {');
        expect(plain.content).not.toContain('is disabled on this server by the operator');
    });

    it('runs or skips the built-in plugin pass on the value the snapshot carries', async () => {
        // The provider is wrapped in a recorder over `lanePluginSettingsProvider`'s answer, so
        // one assertion proves BOTH halves at once: the factory installed the provider the
        // lane would build, and the plugin gate read the OPERATOR's value through it. A
        // dropped forward shows up as an empty key set (the library's own provider answered).
        const keysReadFor = async (plugin: string, override: Record<string, boolean>): Promise<string[]> => {
            const reads = new Set<string>();
            const snapshot = lanePluginSettingsProvider({ [plugin]: override });

            await demoReplica({
                pluginSettings: {
                    get: (name: string, key: string) => {
                        if (name === plugin) reads.add(key);

                        return snapshot?.get(name, key);
                    }
                }
            })('what time is it?');

            return [...reads].sort();
        };

        // Off: the framework's gate reads `enabled` and the pass stops at its Rule 0, so no
        // policy knob is consulted at all - the hooks are not delivered.
        expect(await keysReadFor('context-compaction', { enabled: false })).toEqual(['enabled']);
        // On: the same run consults the whole policy (the limit and the per-model map, which
        // together ARE the firing point now that the headroom knob is gone, and the mode that
        // decides WHICH writer the turn is handed to), which is what "the operator enabled it"
        // has to mean on a replica. `minTokens`/`safetyTurns` are absent because this scripted
        // conversation stays under the limit — those two are read on a turn that FIRES (and in
        // summarize mode `minTokens` is a floor on the live estimate, read only when the
        // conversation is already over the limit).
        expect(await keysReadFor('context-compaction', { enabled: true })).toEqual([
            'contextLimit',
            'enabled',
            'mode',
            'modelLimits'
        ]);
    });
});

// ---------------------------------------------------------------------------
// Level 4 (the deep one): a REAL lane worker, a REAL turn, and the tool list the
// provider was actually sent.
// ---------------------------------------------------------------------------

// The worker entry, exactly as ./lane-worker.test.ts pins it: the source module, imported by
// the thread through the Vite module runner. There is no bundle in this package's publishing
// model, so nothing here can silently assert yesterday's worker.
const WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

const LANE_RUNTIME: ServerRuntimeConfiguration = {
    ...WORKER_RUNTIME,
    workerEntry: WORKER_ENTRY,
    // 0 keeps the lane alive after its turn, so a second session does not pay a second cold
    // start; nothing here re-dispatches into a live lane anyway.
    workerIdleMs: 0,
    maxLaneWorkers: 8,
    workerHandshakeMs: 120_000
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const laneStores: SessionStore[] = [];

// A stub provider that records the BODY of every chat request and answers the rounds it was
// built with, in order (the last round repeats, so an unexpected extra request still settles).
// `requests` is the observation: `tools` is the replica's declaration list, `messages` is the
// context a plugin's `turn.before` pass decided to send.
//
// A MINIMAL VALID completion per round (src/transport/openai.ts's OpenAI shape): the agent
// retries a failed model request with real backoff (src/harness.ts R1), so an error response
// would make these tests wait out retries instead of reading what they already captured.
type Stub = { origin: string; requests: Record<string, any>[]; close: () => Promise<void> };

const stubs: Stub[] = [];

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;

const textRound = (content: string): string =>
    sse({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

const callRound = (id: string, name: string, args: string): string =>
    sse({
        choices: [
            {
                delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: name, arguments: args } }] },
                finish_reason: 'tool_calls'
            }
        ]
    });

const stubRounds = (rounds: string[]): string[] => rounds.slice();

const startProvider = async (rounds: string[]): Promise<Stub> => {
    const requests: Record<string, any>[] = [];
    const scripted = stubRounds(rounds);

    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));

            // The round for THIS request; a run that asks more times than the script answers
            // with the last one, so an unexpected extra request settles instead of hanging.
            const round = scripted[Math.min(requests.length - 1, scripted.length - 1)];

            response.setHeader('Content-Type', 'text/event-stream');
            response.statusCode = 200;
            response.end(round);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const stub: Stub = {
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };

    stubs.push(stub);

    return stub;
};

// The tool names one captured request was given, in the order the replica declared them
// (the OpenAI wire format nests the definition under `function`, src/transport/openai.ts:541).
const requestedTools = (request: Record<string, any> | undefined): string[] =>
    ((request?.tools ?? []) as { function?: { name?: string } }[]).map((entry) => String(entry.function?.name));

const settledTurn = async (store: SessionStore, sessionId: string, turnId: string, limitMs = 120_000): Promise<SessionTurn> => {
    const started = Date.now();

    for (;;) {
        const turn = store.get(sessionId).turns.find((entry) => entry.id === turnId);

        if (turn !== undefined && turn.status !== 'running' && turn.status !== 'queued') return turn;

        if (Date.now() - started > limitMs) {
            throw new Error(`Turn ${turnId} did not settle within ${limitMs}ms (last status: ${turn?.status ?? 'missing'}).`);
        }

        await sleep(25);
    }
};

afterAll(async () => {
    for (const store of laneStores) store.dispose();

    for (const stub of stubs) await stub.close();

    // Give every `terminate()` a tick to land, so a closing vitest pool cannot race a live
    // worker (a leaked worker keeps the process alive, which is its own failure).
    await sleep(250);
});

describe('R3 lane propagation: a worker lane omits a disabled tool from its request toolset', () => {
    // `glob` is the name this proves with for one reason: it is declared on EVERY request by
    // the shared toolbox (core visibility, so no discovery round is needed to make the
    // omission observable). A harness-owned name would work too — the store accepts every
    // switch (R5) — but `glob` keeps this proof about the lane snapshot, not the control plane.
    const DISABLED = 'glob';

    // One session, one lane, one model request, built with `disabled` switched off BEFORE the
    // first dispatch - which is the only moment a lane can learn about it.
    const laneRequestFor = async (disabled: string[]): Promise<string[]> => {
        const provider = await startProvider([textRound('stubbed answer')]);
        const store = new SessionStore(
            { ...SETTINGS, baseURL: `${provider.origin}/v1` },
            createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never),
            undefined,
            { runtime: LANE_RUNTIME }
        );

        laneStores.push(store);

        if (disabled.length > 0) await store.updateToolEnabled(disabled[0], false);

        // 'flaky' is the rebuildable TOOLBOX preset (../harnesses/presets.ts) AND a live
        // transport, so the model request it makes arrives at the stub as bytes - which is the
        // only way to read the replica's declaration list from this process. The scripted
        // 'demo' has no transport to capture (its script is shipped), and it is pinned by its
        // own lane test below.
        const session = await store.create('flaky');
        const submitted = await store.dispatch(session.id, 'what is in the toolset?');
        const turn = await settledTurn(store, session.id, submitted.turn.id);

        expect(turn.status).toBe('done');
        // The turn was SERVED BY A LANE, not by a silent inline fallback: the host exists
        // (it is created lazily on the first worker-mode dispatch, ../sessions.ts `lanes()`)
        // and it holds a live worker for this session with a minted epoch. Without this the
        // assertion below could be satisfied by the coordinator's own harness, which would
        // make the whole test a claim about the inline path.
        const host = (store as unknown as { host?: { lanes(): { sessionKey: string; epoch: number; closed: boolean }[] } }).host;
        const live = host?.lanes().filter((lane) => lane.sessionKey === session.id && !lane.closed) ?? [];

        expect(store.workerExecution).toBe(true);
        expect(live.length).toBeGreaterThan(0);
        expect(live[0]?.epoch).toBeGreaterThanOrEqual(1);
        // The lane really ran: the handshake carried the extra blueprint field, and the
        // provider received exactly one request from that replica.
        expect(provider.requests).toHaveLength(1);

        return requestedTools(provider.requests[0]);
    };

    it('ships the snapshot across the thread and leaves the name out of the model request', async () => {
        const withoutSwitch = await laneRequestFor([]);

        // The control first, so the disabled run's answer is a DIFFERENCE against a list this
        // same build produced, not a guess about what the toolbox registers.
        expect(withoutSwitch).toContain(DISABLED);
        expect(withoutSwitch).toContain('toolRequest');

        const withSwitch = await laneRequestFor([DISABLED]);

        expect(withSwitch).not.toContain(DISABLED);
        // EXACTLY one name removed: the snapshot hides what the switch names and nothing else,
        // so a lane that honours the deny list cannot also lose a neighbour, a slot, or the
        // order. `toolRequest` surviving is the harness-owned control plane staying declared.
        expect(withSwitch).toEqual(withoutSwitch.filter((name) => name !== DISABLED));
        expect(withSwitch).toContain('toolRequest');
    }, 180_000);

    // R1 x THE RECORD REBUILD. A brand-new session's enabled set is seeded with every name the
    // COORDINATOR can switch, and `testFlaky` is one of them: the fixture preset passes it as a
    // `tool()` OBJECT (../harnesses/fixture-presets.test-support.ts:381), which cannot cross a
    // thread — the replica is rebuilt from a record by `presetFromRecord`
    // (../harnesses/registry.ts:873-884, "a factory closure from the coordinator's process cannot
    // cross", ./capability.ts:65). The kernel refuses to restore an enabled name it does not
    // register (src/harness.ts:11611), so before the replica-side prune in ./lane-worker-loop.ts
    // the FIRST lane-served run of a new session died with
    // `Snapshot discovery names "testFlaky", which is not registered in this harness.` and every
    // `turn.status` pin above reported 'error'.
    it('runs a seeded session on a lane although the record rebuild lacks one enabled name', async () => {
        const tools = await laneRequestFor([]);

        // The name this build cannot register is absent from the replica's declaration list...
        expect(tools).not.toContain('testFlaky');
        // ...and every name the replica DOES register keeps its seeded slot, in the replica's own
        // order: the declared core set, the conditional thread tools, then the seeded switchable
        // names. The prune removes exactly one name (`testFlaky`), never a neighbour or a slot.
        expect(tools).toEqual([
            'toolRequest',
            'tasks',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'fetch',
            'threadList',
            'threadRead',
            'threadSend',
            'threadDelete',
            'toolRegistry',
            'toolList',
            'toolManage',
            'toolCreate',
            'records',
            'profiles',
            'chapters',
            'locations',
            'agentManage',
            'agentResult',
            'actionRequest',
            'syntax',
            'files',
            'shell',
            'gitDiff',
            'download',
            'timeNow',
            'textCount',
            'diceRoll',
            'noteSearch',
            'textSummarize'
        ]);
    }, 180_000);
});

describe('R3 lane propagation: a lane replica delivers or skips a plugin pass on the snapshot value', () => {
    // The transcript the shipped `context-trimmer` hook matches by its own rule: an assistant
    // block whose ONLY call was REJECTED (arguments that miss a required property), and a later
    // block whose same-named call COMPLETED (src/plugins/context-trimmer.plugin.ts
    // `planTrimmedUnits`). Its pass runs on the `turn.before` round of the REPLICA - a lane
    // never routes a hook - so whether the NEXT request still carries the failed block IS the
    // answer to "was that plugin's hook delivered on this thread?", read off the bytes the
    // provider was sent.
    const FAILED_CALL = 'lane_trim_failed';
    const FIX_CALL = 'lane_trim_fixed';

    const thirdRequestMessagesFor = async (enabled: boolean): Promise<string[]> => {
        const provider = await startProvider([
            // Round 1: rejected. `timeNow` requires `timezone`, so `{}` is a validation
            // failure, which is the outcome the trimmer's rule calls `rejected`.
            callRound(FAILED_CALL, 'timeNow', '{}'),
            // Round 2: the resolver - the SAME tool, answered `completed`.
            callRound(FIX_CALL, 'timeNow', '{"timezone":"UTC"}'),
            // Round 3: the answer. Its `turn.before` round is where the pass either runs or
            // stops at Rule 0, and its request body is the observation.
            textRound('understood')
        ]);

        const store = new SessionStore(
            { ...SETTINGS, baseURL: `${provider.origin}/v1` },
            createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never),
            undefined,
            { runtime: LANE_RUNTIME }
        );

        laneStores.push(store);

        const session = await store.create('flaky');

        // Written before the first dispatch, the only moment a lane can learn the value, and
        // SESSION-SCOPED (R4): `blueprintFor` reads `session.plugins.snapshot()`
        // (../sessions.ts), so a TEMPLATE `store.updatePluginSettings` here would reach this
        // lane by NOTHING and the third request would answer the shipped defaults. Both cases
        // store an EXPLICIT boolean, so the override map crosses in both directions and neither
        // run is the "no provider at all" default. `supersededTurns: 0` pins the horizon the
        // fixture needs: the trimmer's tool rules now count TOOL TURNS above a unit and protect
        // the newest N (default 2, src/plugins/context-trimmer.plugin.ts), and this transcript
        // has exactly one newer tool turn above the failed block — so the shipped default would
        // protect it and this case would measure a horizon, not the switch.
        await store.updateSessionPluginSettings(session.id, 'context-trimmer', { enabled, supersededTurns: 0 });

        // `timeNow` is searchable: both calls have to EXECUTE (the resolver only counts when it
        // completed), so it goes into the session's enabled set on the canonical harness BEFORE
        // the lane exists, which is what restores it into the replica (../lane-authority.ts
        // `blueprintSnapshot`, shipped on the same `hello` frame).
        store.liveSession(session.id).harness.runtime.manageTool(undefined, { operation: 'enable', name: 'timeNow' });

        const submitted = await store.dispatch(session.id, 'fail it, then fix it');
        const turn = await settledTurn(store, session.id, submitted.turn.id);

        expect(turn.status).toBe('done');
        // Three rounds means the lane ran the tool bodies and re-requested twice - the
        // `turn.before` pass had a candidate to decide about.
        expect(provider.requests).toHaveLength(3);

        return ((provider.requests[2]?.messages ?? []) as unknown[]).map((message) => JSON.stringify(message));
    };

    it('withholds the superseded failure when this session has the plugin on', async () => {
        const messages = await thirdRequestMessagesFor(true);

        // The pass ran on the replica: the failed block is out of the context the model was
        // given, and the completing block is still in it. The value that made that happen came
        // from THIS session's store, on the blueprint - not from the template.
        expect(messages.some((message) => message.includes(FIX_CALL))).toBe(true);
        expect(messages.some((message) => message.includes(FAILED_CALL))).toBe(false);
    }, 180_000);

    it('sends the same transcript untouched when this session switched the plugin off', async () => {
        const messages = await thirdRequestMessagesFor(false);

        // The gate read this session's snapshot's `enabled: false` on this thread, so the
        // handler never ran: the failed block is still in the context, exactly as it was for the
        // two earlier requests. Same preset, same transcript, same lane mechanism - the value is
        // the only difference, which is what makes the pair a proof rather than a coincidence.
        expect(messages.some((message) => message.includes(FIX_CALL))).toBe(true);
        expect(messages.some((message) => message.includes(FAILED_CALL))).toBe(true);
    }, 180_000);
});

describe('R3 lane propagation: a lane-served run honours the switch at the launch gate', () => {
    it('refuses a globally disabled tool inside a lane-served run', async () => {
        // Run on `flaky`, not on the scripted fixture: a lane rebuilds the harness from the
        // preset RECORD alone, and a scripted factory is a closure the worker cannot receive
        // (../harnesses/registry.ts throws for a scripted record with no fallback). `flaky` is
        // rebuildable AND asks for a named tool, so the refusal is observable on the wire.
        const provider = await startProvider([
            // Round 1: the model guesses the disabled name; round 2 is the answer it adapts to.
            callRound('call_lane_gate', 'timeNow', '{"timezone":"UTC"}'),
            textRound('understood')
        ]);

        const store = new SessionStore(
            { ...SETTINGS, baseURL: `${provider.origin}/v1` },
            createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never),
            undefined,
            { runtime: LANE_RUNTIME }
        );

        laneStores.push(store);

        const session = await store.create('flaky');

        // `timeNow` is discovery-visibility, so put it in the SESSION's enabled set first - the
        // same move the plugin case below makes - and only then switch it off globally. That way
        // the only reason the call can fail is the operator's switch, not an out-of-scope name.
        store.liveSession(session.id).harness.runtime.manageTool(undefined, { operation: 'enable', name: 'timeNow' });

        await store.updateToolEnabled('timeNow', false);

        const submitted = await store.dispatch(session.id, 'what time is it?');
        const turn = await settledTurn(store, session.id, submitted.turn.id);

        expect(turn.status).toBe('done');
        // The turn really was lane-served: the provider saw the replica's two requests.
        expect(store.workerExecution).toBe(true);
        expect(provider.requests).toHaveLength(2);

        const refused = (turn.events as unknown as { type: string; name?: string; content?: string }[]).filter(
            (event) => event.type === 'tool_result' && event.name === 'timeNow'
        );

        expect(refused).toHaveLength(1);
        // The launch gate on the REPLICA answered, so the blueprint's deny list reached this
        // lane's harness - and the run survived it, which is what makes the next round happen.
        expect(refused[0]?.content).toBe('Tool "timeNow" is disabled on this server by the operator.');
    }, 180_000);
});
