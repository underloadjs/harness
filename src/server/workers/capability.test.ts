// The worker-mode capability gate: which harnesses may run their threads on lane
// workers, and the EXACT reason when one may not.
//
// Requirement R3's compatibility clause is what these tests pin: an unsupported
// capability must be a named, actionable error rather than a silent inline fallback,
// because "configured worker mode" is a promise about CPU isolation.
//
// Cross-references:
//   - ./capability.ts            - the decision under test
//   - ../harnesses/registry.ts   - presetFromRecord + the injected-factory error
//   - ../harnesses/toolbox.ts    - why a 'live' preset IS rebuildable from data

import { describe, expect, it } from 'vitest';
import type { HarnessPreset } from '../harnesses/types';
import { createHarnessRegistry } from '../harnesses';
import { ALL_PRESET_TEMPLATES } from '../harnesses/presets.ts';
import { ServerRuntimeError } from '../config';
import {
    AUTHORITY_RUNTIME_METHODS,
    LANE_ROUTED_HANDLE_READS,
    LOCAL_RUNTIME_METHODS,
    ROUTED_RUNTIME_METHODS,
    assertWorkerRuntimeReady,
    assessLaneWorkerCapability,
    assessWorkerToolSurface,
    isAuthorityRuntimeMethod,
    isNestedRunTool,
    laneWorkerEnvironment,
    laneWorkerUnsupportedMessage,
    NESTED_RUN_LIMITATION_CODE,
    NESTED_RUN_TOOL_NAMES,
    NESTED_RUN_ARMED_DOORS,
    LANE_NESTED_RUN_DOORS,
    nestedRunDoorReason,
    nestedRunDoorWarning,
    nestedRunLimitationMessage,
    planWorkerToolSurfaces,
    reachesCanonicalDocument,
    reachesNestedRunDoors,
    toolScanTextOf
} from './capability';

const presetOf = (template?: 'live' | 'flaky' | 'scripted', name = 'instruct'): HarnessPreset => ({
    name,
    title: 'Instruction',
    description: 'a team harness',
    requiresEndpoint: true,
    primary: name,
    subagents: ['research'],
    agents: [name, 'research'],
    tools: ['read', 'tasks'],
    builtin: true,
    editable: true,
    ...(template === undefined ? {} : { template }),
    create: () => {
        throw new Error('not called by the capability gate');
    }
});

// The nine documented properties of worker mode, INCLUDING the one limitation the build
// states instead of hiding. They are asserted verbatim: a change to any of them is a change
// to the isolation promise an operator reads.
const WORKER_MODE_NOTES = [
    'In worker mode every harness body runs in a lane worker: a queue turn, the legacy root /messages run, a session-bound direct tool call (POST /tools/:name with a sessionId), and a slash command alike, so the coordinator executes no harness work inline on the event loop.',
    'A session-shared operation (a record store, the tool registry, tool discovery, the agent-result archive, a cross-thread send or roster read) is routed from the lane replica through harness.runtime to the coordinator, which performs it on the canonical harness and returns the answer - so shared state has exactly one writer of record.',
    'A cross-thread READ is routed the same way: harness.threadMessages and harness.thread on a lane replica answer from the canonical harness, so threadRead sees another lane\'s conversation and a thread another lane created, never this replica\'s private copy.',
    'Only the coordinator holds the canonical document: harness.snapshot(), harness.restore(), persistence, the event journal and every SSE response stay on it, because they serialize state rather than compute it.',
    'harness.memory is shared as a bounded window of the keys a tool names. A function or symbol value, or a tool that walks the map dynamically (memory.data, memory.keys(), a computed key), is refused naming the key or tool; nothing is silently dropped or coerced. A window is recomputed when a tool is created: the created revision is scanned at the coordinator before it is installed, its literal memory keys join the window, and one that reaches the map dynamically is refused at creation naming the tool.',
    'An agent default conversation has exactly one writer lane at a time; a lane that reaches an agent another lane holds waits for the lease instead of writing behind it.',
    'A tool registered from anywhere - a lane, the operator, a model - is applied at the coordinator first and broadcast to every live worker, so no replica keeps running a definition the authority replaced.',
    'LIMITATION (nested runs, refused before execution): worker mode does not centralise nested conversation state, so EVERY door that can start a child conversation is refused on a lane, and every refusal names itself (nested-run-unsupported). The policy is ARMED ON EVERY LANE, whatever preset that lane rebuilt - it is a property of the execution mode, not an opt-in a harness can skip - and a replica whose build has no nested-run seam faults the handshake instead of running children on a private copy (there is no inline fallback). The two tool doors - delegate and threadFork - are removed from the replica at hello, and harness.runtime.delegate on a replica throws. The execution-context doors are refused by the armed core at the surfaces it hands the tool itself: context.run/ctx.run in whatever spelling the body uses, the harness callable, harness.sendThreadInput, and a sibling brain run through context.agents - and because a REFUSING replica hands the body a guarded handle view rather than the raw one, a reference the body stores and calls AFTER its own call settled is refused just the same. A refused door creates nothing at all - no child thread record, no transcript append, no provider request. A revision whose captured source reaches one of those doors is refused at hello naming the tool, because a body whose purpose is a nested child has nothing to do on a lane; one that only reaches context.run is reported with the same code, because that is what it gets at runtime, and the shipped textSummarize answers with its documented local condensation instead. A plain read and every routed harness.runtime operation pass through the same view untouched, which is why threadRead, threadSend and threadList keep working in worker mode. An unscanned closure body (a tool the preset factory constructed) is refused the same doors by the armed core, and a harness INJECTED as a factory closure - which no lane can rebuild - is refused worker mode outright (preset-not-rebuildable) rather than run inline. Worker mode does not promise nested conversation state.',
    'A branch audit is lane-local by core design (branch state is deliberately absent from snapshot v1), so worker mode removes the fork tool rather than keeping a private branch the coordinator cannot list. A tool body that touches a canonical-document member of the live handle (harness.snapshot/restore/reset/registerTool/createThread/sendThreadInput and friends) is refused at hello naming the tool, never run against a private copy.'
];

describe('assessLaneWorkerCapability', () => {
    it('accepts every template-backed harness, because a record rebuilds it', () => {
        for (const template of ['live', 'flaky', 'scripted'] as const) {
            expect(assessLaneWorkerCapability(presetOf(template))).toEqual({
                supported: true,
                reasons: [],
                notes: WORKER_MODE_NOTES
            });
        }
    });

    it('rejects an injected preset with the reason and the fix, naming the harness', () => {
        expect(assessLaneWorkerCapability(presetOf(undefined, 'custom'))).toEqual({
            supported: false,
            reasons: [
                {
                    code: 'preset-not-rebuildable',
                    message:
                        'Harness "custom" was injected as a factory closure, so a lane worker cannot rebuild it. Register it as a template-backed harness ("live"), or run this session with threadExecution "inline".'
                }
            ],
            notes: WORKER_MODE_NOTES
        });
    });

    it('reports a missing worker platform as its own reason, before the preset check', () => {
        const capability = assessLaneWorkerCapability(presetOf(undefined), { workersAvailable: false });

        expect(capability.supported).toBe(false);
        expect(capability.reasons).toEqual([
            {
                code: 'worker-unavailable',
                message:
                    'This host has no worker threads, so threadExecution "worker" cannot isolate a thread. Run with threadExecution "inline".'
            }
        ]);
    });

    it('uses an injected platform message verbatim when the host has a better one', () => {
        const capability = assessLaneWorkerCapability(presetOf('live'), {
            workersAvailable: false,
            message: 'This service runs on a runtime without worker threads.'
        });

        expect(capability.reasons).toEqual([
            { code: 'worker-unavailable', message: 'This service runs on a runtime without worker threads.' }
        ]);
    });

    it('lists exactly one worker mode contract set, detached from the module copy', () => {
        // These sentences describe WHAT worker mode is (decisions D1-D5), and every one of
        // them is implemented by the wire: ./lane-host.ts + ./lane-worker-loop.ts (bodies on
        // a lane), ./lane-authority.ts (routed shared operations, targeted commits),
        // ./lane-memory.ts (the bounded window), ./lane-commit.ts (one writer per shared
        // conversation, registry broadcast). Pinned verbatim so a later change to the
        // mechanism has to move the promise deliberately, not accidentally.
        const first = assessLaneWorkerCapability(presetOf('live'));
        const second = assessLaneWorkerCapability(presetOf('live'));

        expect(first.notes).toHaveLength(9);
        expect(first.notes).not.toBe(second.notes);
    });
});

describe('laneWorkerUnsupportedMessage', () => {
    it('formats one readable sentence for one reason', () => {
        const capability = assessLaneWorkerCapability(presetOf(undefined, 'custom'));

        expect(laneWorkerUnsupportedMessage(capability)).toBe(
            'This harness cannot run its threads on worker lanes: Harness "custom" was injected as a factory closure, so a lane worker cannot rebuild it. Register it as a template-backed harness ("live"), or run this session with threadExecution "inline".'
        );
    });

    it('joins several reasons instead of showing only the first', () => {
        expect(
            laneWorkerUnsupportedMessage({
                supported: false,
                reasons: [
                    { code: 'worker-unavailable', message: 'No workers here.' },
                    { code: 'preset-not-rebuildable', message: 'Injected preset.' }
                ],
                notes: []
            })
        ).toBe('This harness cannot run its threads on worker lanes: No workers here. Injected preset.');
    });
});

describe('assessWorkerToolSurface', () => {
    // The per-tool half of the worker contract: a BODY belongs on the lane's CPU, a SHARED
    // operation belongs to the authority (routed through the replica's harness.runtime), and
    // a body that reaches the canonical document or an unbounded memory view is REFUSED
    // before the run rather than executed against a private copy of the session.
    it('routes the shared-state core tools to the authority', () => {
        expect(assessWorkerToolSurface({ name: 'tasks', source: 'export const execute = () => 1;' })).toEqual({
            name: 'tasks',
            placement: 'authority-proxy',
            reasons: [],
            warnings: [],
            memoryKeys: [],
            memoryDynamic: false
        });

        // The set must cover every tool whose RESULT is session state. `threadRead` and
        // `toolCancel` are deliberately NOT here: a roster read is answered by `threadList`
        // (routed) and a cancellation belongs to the run that owns it (lane-local).
        for (const name of ['profiles', 'chapters', 'locations', 'toolCreate', 'toolManage', 'toolRegistry', 'toolRequest', 'toolList', 'threadSend', 'threadList', 'agentManage', 'agentResult']) {
            expect(assessWorkerToolSurface({ name, source: 'x' }).placement).toBe('authority-proxy');
        }

        // A tool that mutates nothing shared keeps its body on the lane - that is the CPU
        // work isolation exists for.
        expect(assessWorkerToolSurface({ name: 'read', source: 'x' }).placement).toBe('lane-local');
        expect(assessWorkerToolSurface({ name: 'shell', source: 'x' }).placement).toBe('lane-local');
        expect(assessWorkerToolSurface({ name: 'delegate', source: 'x' }).placement).toBe('lane-local');
        expect(assessWorkerToolSurface({ name: 'threadFork', source: 'x' }).placement).toBe('lane-local');
        expect(assessWorkerToolSurface({ name: 'toolCancel', source: 'x' }).placement).toBe('lane-local');
    });

    it('names the nested-run refusal on delegate and threadFork without blocking the hello', () => {
        // T12 (S7): a nested run creates a CHILD thread record and transcript that only the
        // lane could see, so worker mode refuses the tool instead of running it privately.
        // The refusal is a WARNING, not a blocking reason: `placement` describes what the
        // replica COULD do (it is a full harness), and ./lane-worker-loop.ts `refuseNestedRuns`
        // is what closes the two paths. A blocking reason would fail the hello and take the
        // whole session out of worker mode, which is not what the limitation says.
        for (const name of NESTED_RUN_TOOL_NAMES) {
            const surface = assessWorkerToolSurface({ name, source: 'return 1;' });

            expect(surface.placement).toBe('lane-local');
            expect(surface.reasons).toEqual([]);
            expect(surface.warnings).toEqual([
                { code: NESTED_RUN_LIMITATION_CODE, message: nestedRunLimitationMessage(name) }
            ]);
            // The message names the fix and the feature that survives, so the operator is not
            // left guessing whether cross-thread work disappeared too.
            expect(nestedRunLimitationMessage(name)).toContain('threadExecution "inline"');
            expect(nestedRunLimitationMessage(name)).toContain('threadRead, threadSend, threadList');
        }

        expect(NESTED_RUN_TOOL_NAMES).toEqual(['delegate', 'threadFork']);
        expect(NESTED_RUN_LIMITATION_CODE).toBe('nested-run-unsupported');
        expect(NESTED_RUN_TOOL_NAMES.filter(isNestedRunTool)).toEqual(['delegate', 'threadFork']);
        expect(isNestedRunTool('threadSend')).toBe(false);
        expect(isNestedRunTool('toolCancel')).toBe(false);

        // A tool that starts no nested run carries no such warning.
        expect(assessWorkerToolSurface({ name: 'read', source: 'return 1;' }).warnings).toEqual([]);
    });

    it('routes exactly the runtime methods the worker intercepts, and no more', () => {
        // The interception surface and the refusal list must be the SAME decision, or a core
        // tool could mutate shared state on a lane with nobody routing it (a lost write).
        expect(Object.keys(AUTHORITY_RUNTIME_METHODS).sort()).toEqual([...ROUTED_RUNTIME_METHODS].sort());
        expect(LOCAL_RUNTIME_METHODS).toEqual(['delegate', 'search', 'fetch']);
        expect(isAuthorityRuntimeMethod('threadSend')).toBe(true);
        expect(isAuthorityRuntimeMethod('delegate')).toBe(false);
        expect(isAuthorityRuntimeMethod('whatever')).toBe(false);
    });

    it('warns about a source-less tool but still runs it lane-local', () => {
        // The replica rebuilds the preset's own tools identically, so "no captured revision"
        // costs only the SCAN. Its shared operations still route, and a memory write for a
        // key it never read is refused - so an opaque body cannot silently overwrite state.
        expect(assessWorkerToolSurface({ name: 'customTool' })).toEqual({
            name: 'customTool',
            placement: 'lane-local',
            reasons: [],
            warnings: [
                {
                    code: 'closure-definition',
                    message:
                        'Tool "customTool" has no captured source revision, so its body could not be scanned for shared reach. It runs lane-local: the replica rebuilt it from the same preset record, its shared operations route to the coordinator, and a memory write it never read is refused rather than merged.'
                }
            ],
            memoryKeys: [],
            memoryDynamic: false
        });
    });

    it('refuses a dynamic memory reach, and bounds a literal one', () => {
        const dynamic = assessWorkerToolSurface({ name: 'noteSearch', source: "const all = { ...harness.memory.data };" });

        expect(dynamic.placement).toBe('unsupported');
        expect(dynamic.memoryDynamic).toBe(true);
        expect(dynamic.reasons).toEqual([
            {
                code: 'memory-dynamic',
                message:
                    'Tool "noteSearch" reaches harness.memory dynamically (memory.data, memory.keys(), or a computed key), so its shared read-set cannot be bounded for a lane worker. Read the keys it needs by name, or run this session with threadExecution "inline".'
            }
        ]);

        expect(assessWorkerToolSurface({ name: 'testFlaky', source: "harness.memory.set('flaky.attempts', n);" })).toMatchObject({
            placement: 'lane-local',
            memoryKeys: ['flaky.attempts'],
            memoryDynamic: false
        });
    });

    it('refuses a tool that reads or replaces the canonical document', () => {
        const surface = assessWorkerToolSurface({ name: 'deepCopy', source: 'const core = context.harness.snapshot();' });

        expect(surface.placement).toBe('unsupported');
        expect(surface.reasons).toEqual([
            {
                code: 'canonical-document-access',
                message:
                    'Tool "deepCopy" calls harness.snapshot on the live handle, which reads or moves the canonical session document. In worker mode only the coordinator may do that; reach the same state through harness.runtime (a routed operation) or run this session with threadExecution "inline".'
            }
        ]);

        // Every refused member is named, and the scan covers the optional-call spelling a
        // modern tool body would write. A bare `harness.snapshot()` (no handle reference) is
        // NOT a match: the scan looks for the live handle, not any identifier named harness.
        expect(reachesCanonicalDocument('const t = context.harness?.createThread("research");')).toEqual(['createThread']);
        expect(reachesCanonicalDocument('context.harness.sendThreadInput(id, "go"); context.harness.restore(core);')).toEqual([
            'restore',
            'sendThreadInput'
        ]);
        expect(reachesCanonicalDocument('return context.harness.threadMessages(id);')).toEqual([]);
        expect(reachesCanonicalDocument('return harness.snapshot();')).toEqual([]);
    });
});

describe('planWorkerToolSurfaces', () => {
    it('lists the routed tools, the bounded memory window, and every refusal', () => {
        const plan = planWorkerToolSurfaces([
            { name: 'read', source: 'x' },
            { name: 'tasks', source: 'x' },
            { name: 'noteSearch', source: "harness.memory.get('noteSearch.cache');" },
            { name: 'threadSend', source: 'x' },
            // A source-less tool is a WARNING, not a refusal: it is rebuilt identically.
            { name: 'hostOpaques' },
            { name: 'deepCopy', source: 'const core = context.harness.snapshot();' }
        ]);

        expect(plan.proxied).toEqual(['tasks', 'threadSend']);
        expect(plan.memoryKeys).toEqual(['noteSearch.cache']);
        expect(plan.unsupported.map((surface) => surface.name)).toEqual(['deepCopy']);
        expect(plan.placements.read.placement).toBe('lane-local');
        expect(plan.placements.hostOpaques.placement).toBe('lane-local');
        expect(plan.placements.hostOpaques.warnings.map((warning) => warning.code)).toEqual(['closure-definition']);
    });

    it('treats an empty toolbox as fully lane-local', () => {
        expect(planWorkerToolSurfaces([])).toEqual({ placements: {}, proxied: [], memoryKeys: [], unsupported: [] });
    });
});

// T10 finding M5: the scan must read the field the production format actually uses.
//
// Every shipped core tool is registered as `format: 'module'`, whose text lives in
// `HarnessToolSource.moduleText`; `source` (the legacy async-body field) is undefined for all
// of them. Reading `.source` therefore handed `planWorkerToolSurfaces` 30 tools with no text,
// which produced an empty refusal list and an empty memory window for VACUOUS reasons - the
// checks passed because nothing was scanned, not because the toolbox was safe.
describe('the real shipped toolbox through the capability lens', () => {
    const settings = { baseURL: 'http://localhost:9/v1', apiKey: '', model: 'demo' } as never;
    const registry = createHarnessRegistry(ALL_PRESET_TEMPLATES as never);
    const preset = registry.list().find((entry: { name: string }) => entry.name === 'flaky') as {
        create: (runnerSettings: never, progress: () => void, options?: never) => any;
    };
    // A thread is created first because the thread trio (`threadRead`, `threadList`,
    // `threadSend`) registers on `activation: 'threads'` - the very first createThread - so an
    // untouched harness does not have it installed and a scan of it proves nothing.
    const harness = preset.create(settings as never, () => undefined);

    harness.createThread('flaky');

    const revisions = new Map<string, string | undefined>(harness.toolSources().map((record: { name: string }) => [record.name, toolScanTextOf(record)]));
    const installed = Object.keys(harness.tools).sort();
    const plan = planWorkerToolSurfaces(installed.map((name: string) => ({ name, source: revisions.get(name) })));

    it('has text for every installed tool, so a refusal is possible at all', () => {
        // The exact regression: the thread trio is installed now, and its revision is a module.
        expect(installed).toContain('threadRead');
        expect(revisions.get('threadRead')).toContain('context.harness.threadMessages');
        expect(installed.filter((name: string) => revisions.get(name) === undefined)).toEqual([]);
        expect(installed.length).toBeGreaterThan(20);
    });

    it('bounds the memory window the shipped toolbox really names', () => {
        // No core tool names a literal `harness.memory` key, so the session window is exactly
        // empty - and it is now an ANSWER from a scan of 30 bodies, not the default of a scan
        // that received 30 undefineds.
        expect(plan.memoryKeys).toEqual([]);
        expect(plan.unsupported).toEqual([]);
        expect(plan.proxied).toEqual([
            'agentManage',
            'agentResult',
            'chapters',
            'locations',
            'profiles',
            // `records` is the low-level engine surface (T3): same route, same reason — a
            // lane that wrote a record locally would lose it the moment the lane died.
            'records',
            'tasks',
            // The thread trio registers on the first createThread, which the fixture does on
            // purpose - a roster read that is not routed is a read of a private copy.
            'threadList',
            'threadSend',
            'toolCreate',
            'toolList',
            'toolManage',
            'toolRegistry',
            'toolRequest'
        ]);
    });

    it('keeps a cross-thread read lane-local because the worker routes it (T10 S1)', () => {
        // `threadRead` reaches two handle members that read shared state. Refusing every thread
        // read would delete the feature in worker mode, so the replica's own handle members are
        // replaced with routed canonical reads instead (./lane-worker-loop.ts).
        expect(LANE_ROUTED_HANDLE_READS).toEqual(['threadMessages', 'thread']);
        expect(reachesCanonicalDocument(revisions.get('threadRead') as string)).toEqual([]);
        expect(plan.placements.threadRead?.placement).toBe('lane-local');
        expect(plan.placements.threadRead?.reasons).toEqual([]);
    });

    it('refuses a created module revision that walks the map dynamically', () => {
        // The input the authority feeds BEFORE installing a model-created tool: the same lens,
        // on the module text (T10 finding S2).
        const dynamic = `const execute = async (context: any) => Object.keys(context.harness.memory.data);`;

        expect(assessWorkerToolSurface({ name: 'createdModule', source: dynamic }).reasons.map((entry) => entry.code)).toEqual(['memory-dynamic']);
        expect(assessWorkerToolSurface({ name: 'createdBody', source: `context.harness.memory.set('created.cache', 1);` }).memoryKeys).toEqual(['created.cache']);
    });
});

// T14: the per-BODY half of the nested-run rule. The runtime guard (src/harness.ts, armed by
// ./lane-worker-loop.ts) is what ENFORCES the tool-context door; this scan is the textual lens
// that names the tool in the report before a turn spends a child. Asserted both ways: what it
// catches, and (honesty) what a text scan cannot catch.
describe('reachesNestedRunDoors', () => {
    const labels = (source: string): string[] => reachesNestedRunDoors(source).map((door) => door.label);

    it('names the literal, optional-chained and callTool spellings', () => {
        expect(labels('export const execute = async (context) => await context.run("summarizer", "notes");')).toEqual(['context.run(name, input)']);
        expect(labels('export const execute = async (ctx) => await ctx?.run("helper", "notes");')).toEqual(['context.run(name, input)']);
        expect(labels('export const execute = async (context) => await context.callTool("delegate", { agent: "helper" });')).toEqual(['context.callTool("delegate" | "threadFork")']);
    });

    it('names the destructured and aliased spellings of the same door', () => {
        // The shipped textSummarize spelling: the context arrives as the parameter list.
        expect(labels('export const execute = async ({ parameters: notes, run, agents, nestedRuns }) => !run ? local : await run("summarizer", notes);')).toEqual(['context.run(name, input)']);
        expect(labels('export const execute = async (context) => { const { run } = context; return await run("helper", "brief"); };')).toEqual(['context.run(name, input)']);
        expect(labels('export const execute = async (context) => { const { run: child } = context; return await child("helper", "brief"); };')).toEqual(['context.run(name, input)']);
        expect(labels('export const execute = async (context) => { const nested = context.run; return await nested("helper", "brief"); };')).toEqual(['context.run(name, input)']);
    });

    it('names the handle doors, which are refused up front AND at the runtime exposure', () => {
        expect(labels('export const execute = async (context) => await context.harness("a second root run");')).toEqual(['context.harness(...)']);
        expect(labels('export const execute = async (context) => { for await (const e of context.agents.writer.turn()) void e; };')).toEqual(['context.agents.<name>.turn() / .stream()']);
        expect(labels('export const execute = async ({ agents }) => await agents["writer"].stream("x");')).toEqual(['context.agents.<name>.turn() / .stream()']);
    });

    it('says nothing when the body starts no child', () => {
        expect(labels('export const execute = async ({ parameters: text }) => text.length;')).toEqual([]);
        // A local function named `run`, or a sibling READ, is not a nested conversation.
        expect(labels('export const execute = async () => { const run = () => 1; return run(); };')).toEqual([]);
        expect(labels('export const execute = async (context) => String(context.agents.helper.model());')).toEqual([]);
        // Bound but never called: the scan reports a REACH, not a declaration.
        expect(labels('export const execute = async (context) => { const { run } = context; return typeof run; };')).toEqual([]);
        // The handle for memory/store access is not the handle used as a runner.
        expect(labels('export const execute = async (context) => context.harness.memory.get("a.key");')).toEqual([]);
    });

    it('is textual, so it never claims more than a scan can know (and the guard covers the rest)', () => {
        // A computed member and a renamed context parameter are invisible to a regex. They are
        // asserted as MISSES on purpose: the guarantee for those bodies is the armed core guard,
        // which closes the same door whatever spelling wrote it (./harness.nested-runs.test.ts).
        expect(labels('export const execute = async (c) => await c["run"]("helper", "brief");')).toEqual([]);
        expect(labels('export const execute = async (toolContext) => await toolContext["run"]("helper", "brief");')).toEqual([]);

        // ... and the report says exactly that, instead of pretending to be a sandbox.
        const surface = assessWorkerToolSurface({ name: 'ctxUser', source: 'export const execute = async (context) => await context.run("helper", "brief");' });

        expect(surface.placement).toBe('lane-local');
        expect(surface.reasons).toEqual([]);
        expect(surface.warnings).toEqual([
            {
                code: NESTED_RUN_LIMITATION_CODE,
                message: nestedRunDoorWarning('ctxUser', 'context.run(name, input)')
            }
        ]);
        expect(surface.warnings[0].message).toContain(NESTED_RUN_LIMITATION_CODE);
        expect(surface.warnings[0].message).toContain('The scan is TEXTUAL');
    });

    it('refuses a body whose own source starts the nested conversation, and only that one', () => {
        // `unsupported` is the right placement HERE: the revision would install a tool whose whole
        // purpose is a child no commit can publish. T15 corrected WHY this is a reason rather than
        // a warning - NOT because the runtime is blind (an armed replica refuses the same door at
        // the guarded handle it hands the body), but because the scanned source proves the body has
        // no worker-safe path left, so a lane must not promise the model a call that can only fail.
        const viaHandle = assessWorkerToolSurface({ name: 'secondRoot', source: 'export const execute = async (context) => await context.harness("more work");' });

        expect(viaHandle.placement).toBe('unsupported');
        expect(viaHandle.warnings).toEqual([]);
        expect(viaHandle.reasons).toEqual([
            {
                code: NESTED_RUN_LIMITATION_CODE,
                message: nestedRunDoorReason('secondRoot', 'context.harness(...)')
            }
        ]);
        expect(viaHandle.reasons[0].message).toContain('refused BEFORE it is installed');
        expect(viaHandle.reasons[0].message).toContain('guarded view');
        expect(viaHandle.reasons[0].message).toContain('threadExecution "inline"');

        // A door the core refuses stays lane-local: refusing it outright would take the whole
        // toolbox out of worker mode because one shipped tool summarises through a subagent.
        const nestedRunTool = assessWorkerToolSurface({ name: 'textSummarize', source: 'export const execute = async ({ parameters: notes, run, agents, nestedRuns }) => (!run || summarizer === undefined || nestedRuns === "refuse") ? condense(notes) : (await run("summarizer", notes)).content;' });

        expect(nestedRunTool.placement).toBe('lane-local');
        expect(nestedRunTool.reasons).toEqual([]);
        expect(nestedRunTool.warnings.map((warning) => warning.code)).toEqual([NESTED_RUN_LIMITATION_CODE]);
    });

    it('lists the armed doors once each, in the order the handshake reports them', () => {
        // T15: `sendThreadInput` joined the list because a REFUSING replica now refuses it at the
        // handle it hands the tool (`toolHandleView`), exactly like the callable and a brain run;
        // the door order below is the order `nestedRunHandshakeLimitations` reports them in.
        expect(NESTED_RUN_ARMED_DOORS).toEqual(['context.run(name, input)', 'harness(...) called from a tool body', 'harness.sendThreadInput(...) called from a tool body', 'harness.agents.<name>.turn() / .stream()']);
        expect(LANE_NESTED_RUN_DOORS.map((door) => [door.label, door.blocking])).toEqual([
            ['context.run(name, input)', false],
            ['context.harness(...)', true],
            ['context.agents.<name>.turn() / .stream()', true],
            ['context.callTool("delegate" | "threadFork")', false]
        ]);
    });
});

describe('toolScanTextOf', () => {
    it('prefers the module revision, which is the format every shipped tool uses', () => {
        expect(toolScanTextOf({ moduleText: 'export const execute = 1;', source: 'return 1;' })).toBe('export const execute = 1;');
        expect(toolScanTextOf({ source: 'return 1;' })).toBe('return 1;');
        // Nothing captured at all: a host-supplied closure definition, which the plan keeps as
        // a warning rather than inventing a refusal for.
        expect(toolScanTextOf({})).toBeUndefined();
    });

    it('scans captured helpers, because that is where a real body keeps its memory reach', () => {
        const text = toolScanTextOf({
            moduleText: `const execute = async (context: any) => helper(context);`,
            dependencies: [{ path: './helper.ts', text: `context.harness.memory.set('helper.cache', 1);` }]
        }) as string;

        expect(text).toContain('helper(context)');
        expect(text).toContain("'helper.cache'");
        expect(assessWorkerToolSurface({ name: 'withHelper', source: text }).memoryKeys).toEqual(['helper.cache']);
    });
});

describe('laneWorkerEnvironment', () => {
    it('reports the Node test host as able to spawn workers', () => {
        // Guards the probe itself: Node 24 has no global `Worker`, so a global probe
        // would wrongly report false here.
        expect(laneWorkerEnvironment()).toEqual({ workersAvailable: true });
    });
});

describe('assertWorkerRuntimeReady', () => {
    it('accepts the inline runtime, which is what this build fully executes', () => {
        expect(() => assertWorkerRuntimeReady({ threadExecution: 'inline' })).not.toThrow();
    });

    it('accepts a configured worker runtime on a host that really has workers', () => {
        // T5 replaced the "substrate only" refusal with the real thing: worker mode now runs
        // lanes, so the only deployment-level refusal left is a platform with no worker
        // threads. This host HAS them (see laneWorkerEnvironment above), so worker mode must
        // be accepted - refusing it would be the same broken promise in the other direction.
        expect(() => assertWorkerRuntimeReady({ threadExecution: 'inline' })).not.toThrow();
        expect(() => assertWorkerRuntimeReady({ threadExecution: 'worker' })).not.toThrow();
    });

    it('reports an unusable worker platform as a deployment error, naming the fix', () => {
        // The message the gate produces for a host without worker threads is the same
        // sentence the platform probe writes, so the HTTP surface, the CLI and the operator
        // all quote one reason instead of three near-misses.
        const platform = laneWorkerEnvironment();
        const refusal = platform.workersAvailable
            ? new ServerRuntimeError(platform.message ?? 'This process does not provide worker threads.')
            : undefined;

        if (refusal === undefined) {
            expect(laneWorkerUnsupportedMessage(assessLaneWorkerCapability(presetOf('live'), { workersAvailable: false }))).toContain(
                'threadExecution "inline"'
            );

            return;
        }

        expect(refusal).toBeInstanceOf(ServerRuntimeError);
    });
});
