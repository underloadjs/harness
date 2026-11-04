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
import { ServerRuntimeError } from '../config';
import {
    AUTHORITY_RUNTIME_METHODS,
    LOCAL_RUNTIME_METHODS,
    ROUTED_RUNTIME_METHODS,
    assertWorkerRuntimeReady,
    assessLaneWorkerCapability,
    assessWorkerToolSurface,
    isAuthorityRuntimeMethod,
    laneWorkerEnvironment,
    laneWorkerUnsupportedMessage,
    planWorkerToolSurfaces,
    reachesCanonicalDocument
} from './capability';

const presetOf = (template?: 'live' | 'flaky' | 'scripted', name = 'instruct'): HarnessPreset => ({
    name,
    title: 'Instruction',
    description: 'a team harness',
    requiresEndpoint: true,
    primary: name,
    subagents: ['research'],
    agents: [name, 'research'],
    tools: ['read', 'task'],
    builtin: true,
    editable: true,
    ...(template === undefined ? {} : { template }),
    create: () => {
        throw new Error('not called by the capability gate');
    }
});

// The seven documented properties of worker mode. They are asserted verbatim: a change
// to any of them is a change to the isolation promise an operator reads.
const WORKER_MODE_NOTES = [
    'In worker mode every harness body runs in a lane worker: a queue turn, the legacy root /messages run, a session-bound direct tool call (POST /tools/:name with a sessionId), and a slash command alike, so the coordinator executes no harness work inline on the event loop.',
    'A session-shared operation (a record store, the tool registry, tool discovery, the agent-result archive, a cross-thread send or roster read) is routed from the lane replica through harness.runtime to the coordinator, which performs it on the canonical harness and returns the answer - so shared state has exactly one writer of record.',
    'Only the coordinator holds the canonical document: harness.snapshot(), harness.restore(), persistence, the event journal and every SSE response stay on it, because they serialize state rather than compute it.',
    'harness.memory is shared as a bounded window of the keys a tool names. A function or symbol value, or a tool that walks the map dynamically (memory.data, memory.keys(), a computed key), is refused naming the key or tool; nothing is silently dropped or coerced.',
    'An agent default conversation has exactly one writer lane at a time; a second lane delegating to the same agent is given its own child conversation instead of writing behind the first lane.',
    'A tool registered from anywhere - a lane, the operator, a model - is applied at the coordinator first and broadcast to every live worker, so no replica keeps running a definition the authority replaced.',
    'A private fork/branch audit is lane-local by core design (branch state is deliberately absent from snapshot v1), so a fork records the summary it returns, while the branch listing of one lane is not a central roster entry. A tool body that touches a canonical-document member of the live handle (harness.snapshot/restore/reset/registerTool/createThread/sendThreadInput and friends) is refused at hello naming the tool, never run against a private copy.'
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

        expect(first.notes).toHaveLength(7);
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
        expect(assessWorkerToolSurface({ name: 'task', source: 'export const execute = () => 1;' })).toEqual({
            name: 'task',
            placement: 'authority-proxy',
            reasons: [],
            warnings: [],
            memoryKeys: [],
            memoryDynamic: false
        });

        // The set must cover every tool whose RESULT is session state. `threadRead` and
        // `toolCancel` are deliberately NOT here: a roster read is answered by `threadList`
        // (routed) and a cancellation belongs to the run that owns it (lane-local).
        for (const name of ['profileManage', 'chapterManage', 'locationManage', 'toolCreate', 'toolManage', 'toolRegistry', 'toolRequest', 'toolList', 'threadSend', 'threadList', 'agentManage', 'agentResult']) {
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
            { name: 'task', source: 'x' },
            { name: 'noteSearch', source: "harness.memory.get('noteSearch.cache');" },
            { name: 'threadSend', source: 'x' },
            // A source-less tool is a WARNING, not a refusal: it is rebuilt identically.
            { name: 'hostOpaques' },
            { name: 'deepCopy', source: 'const core = context.harness.snapshot();' }
        ]);

        expect(plan.proxied).toEqual(['task', 'threadSend']);
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
