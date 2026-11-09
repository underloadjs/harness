// R3 (the two DEPLOYMENT-WIDE switches) x worker lanes: the deny list and the plugin
// overrides reach a lane worker as DATA.
//
// WHY THIS FILE EXISTS
// --------------------
// The coordinator hands every harness the stores' LIVE providers (../sessions.ts
// `buildHarness` -> `HarnessPresetReport.toolSettings` / `.pluginSettings` ->
// ../harnesses/toolbox.ts -> `HarnessConfiguration`), and the runtime re-reads them per
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
//      creation (./lane-host.ts merges them into `LaneBlueprint` verbatim), as plain
//      structured-cloneable data (the wire rule), and a value captured at creation does not
//      move when the operator edits the store afterwards - the documented lane semantics.
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
// scripted `demo` factory builds its own `harness({...})` and had to be taught to forward
// `toolSettings`/`pluginSettings` at all (../harnesses/presets.ts); it is pinned separately,
// inline AND on a lane, because every lane integration test in this folder runs on that preset
// and a switch the shipped fixture ignores is a switch an operator cannot see working.
//
// Cross-references:
//   - ./protocol.ts                   `LaneBlueprint.disabledTools` / `.pluginSettings`
//   - ./lane-host.ts                  `LaneBlueprintSource` + the `{...blueprintSource}` merge
//   - ./lane-worker-loop.ts           `laneToolSettingsProvider`, `lanePluginSettingsProvider`,
//                                     `sayHello`'s create call
//   - ../sessions.ts                  `blueprintFor` (the read at lane creation), `buildHarness`
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
import { ALL_PRESET_TEMPLATES } from '../harnesses/presets';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import { SessionStore } from '../sessions';
import type { HarnessPluginSettingsProvider } from '../../types';
import type { RunnerSettings } from '../harnesses/types';
import type { SessionTurn } from '../protocol';
import type { LaneBlueprintSource } from './lane-host';
import { lanePluginSettingsProvider, laneToolSettingsProvider } from './lane-worker-loop';
import { buildTestWorkerEntry } from './worker-test-build.test-support';

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
    const store = new SessionStore(SETTINGS, createHarnessRegistry(ALL_PRESET_TEMPLATES as never), undefined, {
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

        // "No plugin setting has ever been changed" is an EMPTY map, the same fact the
        // durable document expresses by omitting the field (../persistence.ts
        // `pluginSettings`), and the worker reads it as "install no provider".
        expect(blueprintOf(store, session.id).pluginSettings).toEqual({});

        await store.updatePluginSettings('context-trimmer', { enabled: false });

        expect(blueprintOf(store, session.id).pluginSettings).toEqual({ 'context-trimmer': { enabled: false } });

        // A non-boolean knob crosses too - the plugin gate is not the only value a replica
        // used to answer with its shipped default - and the map keeps catalogue order.
        await store.updatePluginSettings('context-compaction', { contextLimit: 4096, gapTokens: 0 });

        const blueprint = blueprintOf(store, session.id);

        expect(blueprint.pluginSettings).toEqual({
            'context-compaction': { contextLimit: 4096, gapTokens: 0 },
            'context-trimmer': { enabled: false }
        });
        // One source of truth: the SAME map `state.json` carries (../plugins.ts `snapshot`),
        // and every value is a JSON scalar, so the frame is structured-cloneable data.
        expect(blueprint.pluginSettings).toEqual(store.pluginSettings.snapshot());
        expect(structuredClone(blueprint.pluginSettings)).toEqual({
            'context-compaction': { contextLimit: 4096, gapTokens: 0 },
            'context-trimmer': { enabled: false }
        });

        // A reset drops the key, so the next lane answers that plugin's declared default.
        await store.updatePluginSettings('context-trimmer', { enabled: null });

        expect(blueprintOf(store, session.id).pluginSettings).toEqual({
            'context-compaction': { contextLimit: 4096, gapTokens: 0 }
        });
    });

    it('is a lane-creation snapshot for the plugin values as well', async () => {
        const store = storeOf();
        const session = await store.create('demo');

        const created = blueprintOf(store, session.id);

        await store.updatePluginSettings('async-ping', { enabled: false });

        expect(created.pluginSettings).toEqual({});
        expect(blueprintOf(store, session.id).pluginSettings).toEqual({ 'async-ping': { enabled: false } });
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
        const preset = createHarnessRegistry(ALL_PRESET_TEMPLATES as never).find('flaky');

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
    // The demo's factory builds the harness directly (../harnesses/presets.ts), so it is the
    // one preset whose own forwarding has to be pinned: until it forwarded
    // `report.toolSettings`/`report.pluginSettings`, a demo session - INLINE or on a LANE -
    // ignored the operator's switches entirely, and every lane integration test in this
    // folder runs on that preset.
    const demoReplica = (report: { toolSettings?: ReturnType<typeof laneToolSettingsProvider>; pluginSettings?: HarnessPluginSettingsProvider }) => {
        const preset = createHarnessRegistry(ALL_PRESET_TEMPLATES as never).find('demo');

        if (preset === undefined) throw new Error('The scripted demo preset is not shipped in this build.');

        return presetFromRecord(presetToRecord(preset)).create(SETTINGS, () => undefined, report);
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
        // On: the same run consults the whole policy (the limit, the headroom and the
        // per-model map), which is what "the operator enabled it" has to mean on a replica.
        expect(await keysReadFor('context-compaction', { enabled: true })).toEqual([
            'contextLimit',
            'enabled',
            'gapTokens',
            'modelLimits'
        ]);
    });
});

// ---------------------------------------------------------------------------
// Level 4 (the deep one): a REAL lane worker, a REAL turn, and the tool list the
// provider was actually sent.
// ---------------------------------------------------------------------------

// The SOURCE worker entry, exactly as ./lane-worker.test.ts pins it: `dist/` is only as
// fresh as the last build, so a bundle would let this test assert yesterday's worker. On a
// Node build without the type transform, the Vite-built entry from
// ./worker-test-build.test-support.ts is the same code the build would ship.
const SOURCE_WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));
const SOURCE_WORKER_SUPPORTED = (process.features as { typescript?: string | false }).typescript !== false;
const BUILT_TEST_WORKER = SOURCE_WORKER_SUPPORTED ? undefined : await buildTestWorkerEntry(SOURCE_WORKER_ENTRY);
const WORKER_ENTRY = BUILT_TEST_WORKER?.entry ?? SOURCE_WORKER_ENTRY;

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

    BUILT_TEST_WORKER?.dispose();
});

describe('R3 lane propagation: a worker lane omits a disabled tool from its request toolset', () => {
    // `glob` is the name this proves with, and it is chosen for two reasons: it is declared
    // on EVERY request by the shared toolbox (core visibility, so no discovery round is
    // needed to make the omission observable), and it is not harness-owned, so the store
    // accepts the switch at all (`CORE_TOOL_NAMES` would be a 403).
    const DISABLED = 'glob';

    // One session, one lane, one model request, built with `disabled` switched off BEFORE the
    // first dispatch - which is the only moment a lane can learn about it.
    const laneRequestFor = async (disabled: string[]): Promise<string[]> => {
        const provider = await startProvider([textRound('stubbed answer')]);
        const store = new SessionStore(
            { ...SETTINGS, baseURL: `${provider.origin}/v1` },
            createHarnessRegistry(ALL_PRESET_TEMPLATES as never),
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
            createHarnessRegistry(ALL_PRESET_TEMPLATES as never),
            undefined,
            { runtime: LANE_RUNTIME }
        );

        laneStores.push(store);

        const session = await store.create('flaky');

        // Written before the first dispatch, the only moment a lane can learn the value. Both
        // cases store an EXPLICIT boolean, so the override map crosses in both directions and
        // neither run is the "no provider at all" default.
        await store.updatePluginSettings('context-trimmer', { enabled });

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

    it('withholds the superseded failure when the operator left the plugin on', async () => {
        const messages = await thirdRequestMessagesFor(true);

        // The pass ran on the replica: the failed block is out of the context the model was
        // given, and the completing block is still in it.
        expect(messages.some((message) => message.includes(FIX_CALL))).toBe(true);
        expect(messages.some((message) => message.includes(FAILED_CALL))).toBe(false);
    }, 180_000);

    it('sends the same transcript untouched when the operator switched the plugin off', async () => {
        const messages = await thirdRequestMessagesFor(false);

        // The gate read the snapshot's `enabled: false` on this thread, so the handler never
        // ran: the failed block is still in the context, exactly as it was for the two earlier
        // requests. Same preset, same transcript, same lane mechanism - the value is the only
        // difference, which is what makes the pair a proof rather than a coincidence.
        expect(messages.some((message) => message.includes(FIX_CALL))).toBe(true);
        expect(messages.some((message) => message.includes(FAILED_CALL))).toBe(true);
    }, 180_000);
});

describe('R3 lane propagation: the demo preset honours the switches on a lane too', () => {
    it('refuses a globally disabled tool inside a lane-served demo run', async () => {
        // The scripted preset needs no endpoint, so this is the cheapest real-lane run there
        // is - and the one that used to ignore the switch even INLINE, because its factory
        // dropped `report.toolSettings` (../harnesses/presets.ts).
        const store = new SessionStore(SETTINGS, createHarnessRegistry(ALL_PRESET_TEMPLATES as never), undefined, {
            runtime: LANE_RUNTIME
        });

        laneStores.push(store);

        const session = await store.create('demo');

        await store.updateToolEnabled('timeNow', false);

        const submitted = await store.dispatch(session.id, 'what time is it?');
        const turn = await settledTurn(store, session.id, submitted.turn.id);

        expect(turn.status).toBe('done');

        const refused = (turn.events as unknown as { type: string; name?: string; content?: string }[]).filter(
            (event) => event.type === 'tool_result' && event.name === 'timeNow'
        );

        expect(refused).toHaveLength(1);
        // The launch gate on the REPLICA answered, so the blueprint's deny list reached this
        // lane's harness - and the demo's own scripted next round quotes that refusal.
        expect(refused[0]?.content).toBe('Tool "timeNow" is disabled on this server by the operator.');
    }, 180_000);
});
