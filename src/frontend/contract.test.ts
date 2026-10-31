// Contract accessors: descriptor extensions, timings and aliases.
//
// Every helper has a documented fallback for an older server, which is what keeps
// the frontend bootable while the backend contract lands. These tests pin the
// fallbacks as exact values so a later "cleanup" cannot silently start guessing.

import type {
    HarnessDescriptor,
    HarnessEvent,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../server/protocol';
import {
    agentModelsOf,
    agentsFromDescriptors,
    builtinOf,
    callIdOf,
    canonicalHarnessName,
    coreToolsOf,
    editableOf,
    eventTimesOf,
    frameAtOf,
    frameUsageOf,
    frozenDefinitionOf,
    membersOf,
    modelsForMembers,
    pendingOf,
    primaryOf,
    subagentsOf,
    toolDurationOf,
    uniqueNames,
    usageOf,
    wakeupOf
} from './contract';

const descriptor = (overrides: Record<string, unknown> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        ...overrides
    }) as HarnessDescriptor;

describe('descriptor extensions', () => {
    it('prefers an explicit primary and falls back to the first agent, then the name', () => {
        expect(primaryOf(descriptor({ primary: 'summarizer', agents: ['instruct', 'summarizer'] }))).toBe(
            'summarizer'
        );
        expect(primaryOf(descriptor({ agents: ['writer', 'helper'] }))).toBe('writer');
        expect(primaryOf(descriptor({ agents: [] }))).toBe('instruct');
    });

    it('uses the explicit subagent list, excluding the primary', () => {
        expect(
            subagentsOf(descriptor({ primary: 'instruct', subagents: ['helper', 'instruct', 'critic'] }))
        ).toEqual(['helper', 'critic']);
        // No explicit list: every other declared agent is a subagent.
        expect(subagentsOf(descriptor({ agents: ['instruct', 'helper'] }))).toEqual(['helper']);
    });

    it('returns the team primary-first without duplicates', () => {
        expect(
            membersOf(
                descriptor({
                    primary: 'helper',
                    agents: ['helper', 'instruct'],
                    subagents: ['instruct', 'helper']
                })
            )
        ).toEqual(['helper', 'instruct']);
        expect(membersOf(descriptor({ agents: ['only'] }))).toEqual(['only']);
    });

    it('deduplicates while preserving order', () => {
        expect(uniqueNames(['b', 'a', 'b', '', 'a', 'c'])).toEqual(['b', 'a', 'c']);
        expect(uniqueNames([])).toEqual([]);
    });

    it('reports every harness editable, ignoring the legacy editable flag (R21.1)', () => {
        // R21.1: no read-only harnesses. The backend accepts PATCH for every preset
        // (demo/flaky included), so a stored `editable:false` is old-server metadata
        // and must never disable a card or render a read-only badge.
        expect(editableOf(descriptor())).toBe(true);
        expect(editableOf(descriptor({ editable: true }))).toBe(true);
        expect(editableOf(descriptor({ editable: false }))).toBe(true);
        expect(builtinOf(descriptor({ builtin: true }))).toBe(true);
        expect(builtinOf(descriptor())).toBe(false);
    });

    it('uses the server core set verbatim, and falls back only for an older payload', () => {
        // R18: the descriptor carries catalogue/runtime visibility, so the UI must
        // not filter it down to the old harness-owned names.
        expect(
            coreToolsOf(
                descriptor({
                    coreTools: ['fileRead', 'fileWrite', 'fileEdit', 'fileGlob', 'webSearch', 'toolRequest']
                }),
                1
            )
        ).toEqual(['fileRead', 'fileWrite', 'fileEdit', 'fileGlob', 'webSearch', 'toolRequest']);

        // An older server with no `coreTools`: the legacy harness-owned fallback,
        // adding delegate when the local team has a second member.
        expect(coreToolsOf(descriptor(), 2)).toEqual([
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'agentDelegate'
        ]);
        expect(coreToolsOf(descriptor(), 1)).toEqual([
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage'
        ]);
    });
});

describe('session timings', () => {
    const turn = (overrides: Record<string, unknown> = {}): SessionTurn =>
        ({
            id: 't1',
            index: 0,
            prompt: 'p',
            status: 'done',
            startedAt: 1000,
            updatedAt: 2000,
            events: [],
            ...overrides
        }) as SessionTurn;

    it('returns undefined for a record without eventTimes', () => {
        expect(eventTimesOf(turn())).toBeUndefined();
        expect(eventTimesOf(turn({ eventTimes: [] }))).toBeUndefined();
    });

    it('keeps finite stamps and marks malformed entries as unknown', () => {
        expect(eventTimesOf(turn({ eventTimes: [1000, 'x', Number.NaN, 1750] }))).toEqual([
            1000,
            undefined,
            undefined,
            1750
        ]);
    });

    it('reads a stream frame timestamp only from event frames', () => {
        const event = { type: 'text', agent: 'a', delta: 'x' } as HarnessEvent;
        const frame = (extra: Record<string, unknown>): SessionStreamItem =>
            ({ type: 'event', turnId: 't1', event, ...extra }) as SessionStreamItem;

        expect(frameAtOf(frame({ at: 1234 }))).toBe(1234);
        expect(frameAtOf(frame({}))).toBeUndefined();
        expect(frameAtOf({ type: 'turn', turn: turn() })).toBeUndefined();
    });

    it('reads an optional call id from a tool result', () => {
        expect(
            callIdOf({
                type: 'tool_result',
                agent: 'a',
                name: 'fileRead',
                content: 'x',
                isError: false,
                callId: 'c1'
            } as HarnessEvent)
        ).toBe('c1');
        expect(
            callIdOf({ type: 'tool_result', agent: 'a', name: 'fileRead', content: 'x', isError: false })
        ).toBeUndefined();
        expect(callIdOf({ type: 'text', agent: 'a', delta: 'x' })).toBeUndefined();
    });

    it('reads a frozen definition only when it names a harness', () => {
        const frozen = descriptor();
        const session = { harnessDefinition: frozen } as unknown as SessionSnapshot;
        expect(frozenDefinitionOf(session)).toBe(frozen);

        expect(frozenDefinitionOf({} as SessionSnapshot)).toBeUndefined();
        expect(
            frozenDefinitionOf({ harnessDefinition: { title: 'no name' } } as unknown as SessionSnapshot)
        ).toBeUndefined();
    });
});

describe('per-agent models', () => {
    it('reads only non-empty string ids from a descriptor or snapshot map', () => {
        expect(
            agentModelsOf(descriptor({ agentModels: { instruct: 'm1', helper: '', bad: 7 } }))
        ).toEqual({ instruct: 'm1' });
        // A map-less descriptor is the normal "everything inherits" shape.
        expect(agentModelsOf(descriptor())).toEqual({});
        expect(
            agentModelsOf({
                agentModels: { instruct: 'm2', helper: 'm1' }
            } as unknown as SessionSnapshot)
        ).toEqual({ instruct: 'm2', helper: 'm1' });
    });

    it('filters a complete map down to the resulting members, dropping removed keys', () => {
        const current = { instruct: 'm2', helper: 'm1', critic: 'm3' };

        // Promotion keeps every member's override.
        expect(modelsForMembers(current, ['helper', 'instruct', 'critic'])).toEqual(current);
        // Removal drops the removed member's key.
        expect(modelsForMembers(current, ['instruct', 'critic'])).toEqual({ instruct: 'm2', critic: 'm3' });
        // No members left means an empty map (the server would clear on PATCH).
        expect(modelsForMembers(current, [])).toEqual({});
    });
});

describe('agent library fallback', () => {
    it('collects unique agent names from descriptors in order', () => {
        const agents = agentsFromDescriptors([
            descriptor({ agents: ['instruct', 'helper'] }),
            descriptor({ name: 'research', agents: ['helper', 'summarizer'] })
        ]);

        expect(agents.map((agent) => agent.name)).toEqual(['instruct', 'helper', 'summarizer']);
        expect(agents[0]).toEqual({
            name: 'instruct',
            title: 'instruct',
            description: 'This server does not advertise agent details.',
            instruction: '',
            guidelines: []
        });
    });
});

describe('canonicalHarnessName', () => {
    const catalogue = [descriptor({ name: 'instruct' }), descriptor({ name: 'research' })];

    it('maps legacy aliases onto the canonical descriptor', () => {
        expect(canonicalHarnessName('writer', catalogue)).toBe('instruct');
        expect(canonicalHarnessName('assistant', catalogue)).toBe('instruct');
        expect(canonicalHarnessName('researcher', catalogue)).toBe('research');
    });

    it('keeps canonical and unknown names unchanged', () => {
        expect(canonicalHarnessName('research', catalogue)).toBe('research');
        expect(canonicalHarnessName('retired', catalogue)).toBe('retired');
        // An alias with no canonical descriptor in this catalogue stays as-is.
        expect(canonicalHarnessName('writer', [descriptor({ name: 'demo' })])).toBe('writer');
    });
});

// Token tallies: the wire's `usage` block (a recorded turn's, or a stream
// frame's) is validated HERE, once, so the tile either prints a server figure or
// nothing at all. `toEqual` is deliberate on the accept cases: it fails on an
// extra `cached` key, which is how "absent stays absent" is pinned (an absent
// cache figure must not render as `(0)` — see src/frontend/ui/tokens.ts).
describe('token tallies', () => {
    it('normalizes a complete tally and keeps a reported cache figure', () => {
        expect(usageOf({ input: 3, output: 2, total: 5 })).toEqual({ input: 3, output: 2, total: 5 });
        expect(usageOf({ input: 3, output: 2, total: 5, cached: 4 })).toEqual({
            input: 3,
            output: 2,
            total: 5,
            cached: 4
        });
    });

    it('rejects a partial, mistyped or non-object tally', () => {
        // Every count is required: a half-sum would print a figure the server never
        // reported, so the whole block resolves to undefined instead.
        expect(usageOf({ input: 3, output: 2 })).toBeUndefined();
        expect(usageOf({ input: '3', output: 2, total: 5 })).toBeUndefined();
        expect(usageOf({ output: 2, total: 5 })).toBeUndefined();
        expect(usageOf(null)).toBeUndefined();
        expect(usageOf(undefined)).toBeUndefined();
        // An array is an object at runtime but never a tally block.
        expect(usageOf([1, 2])).toBeUndefined();
    });

    it('drops a non-finite cache figure without dropping the tally', () => {
        expect(usageOf({ input: 3, output: 2, total: 5, cached: Number.NaN })).toEqual({
            input: 3,
            output: 2,
            total: 5
        });
        expect(usageOf({ input: 3, output: 2, total: 5, cached: Infinity })).toEqual({
            input: 3,
            output: 2,
            total: 5
        });
    });

    it('reads a tally from event frames only', () => {
        const event = { type: 'text', agent: 'a', delta: 'x' } as HarnessEvent;
        const frame = (extra: Record<string, unknown>): SessionStreamItem =>
            ({ type: 'event', turnId: 't1', event, ...extra }) as SessionStreamItem;

        // Minimal but structurally valid non-event frames: the accessor must read
        // them without throwing and report no tally.
        const recorded = {
            id: 't1',
            index: 0,
            prompt: 'p',
            status: 'done',
            startedAt: 1,
            updatedAt: 2,
            events: []
        } as SessionTurn;
        const session = {
            id: 's1',
            harness: 'instruct',
            status: 'idle',
            model: 'm1',
            createdAt: 1,
            updatedAt: 2,
            messages: [],
            turns: []
        } as SessionSnapshot;

        expect(frameUsageOf(frame({ usage: { input: 3, output: 2, total: 5, cached: 4 } }))).toEqual({
            input: 3,
            output: 2,
            total: 5,
            cached: 4
        });
        // A frame with no tally, and a frame whose tally is malformed, both leave
        // the tile's figure alone (main.ts only calls setUsage for a real one).
        expect(frameUsageOf(frame({}))).toBeUndefined();
        expect(frameUsageOf(frame({ usage: { input: 3 } }))).toBeUndefined();
        expect(frameUsageOf({ type: 'turn', turn: recorded })).toBeUndefined();
        expect(frameUsageOf({ type: 'snapshot', session })).toBeUndefined();
    });
});

// --- Background/concurrent tool fields (R6) ---------------------------------
//
// The canonical members now live in the `HarnessEvent` union. These helpers still
// cast: the tests deliberately feed MALFORMED/LEGACY payloads (missing fields, wrong
// value types) that the runtime would not send but persisted data can contain, and
// the accessors must degrade instead of throwing.
const pendingTools = [
    { callId: 'c1', name: 'fileRead', elapsedMs: 1200 },
    { callId: 'c2', name: 'webSearch', elapsedMs: 900 }
];

const resultWith = (fields: Record<string, unknown>): HarnessEvent =>
    ({
        type: 'tool_result',
        agent: 'writer',
        name: 'fileRead',
        content: 'ok',
        isError: false,
        ...fields
    }) as unknown as HarnessEvent;

const doneWith = (fields: Record<string, unknown>): HarnessEvent =>
    ({
        type: 'done',
        agent: 'writer',
        message: {
            role: 'assistant',
            content: 'answer',
            reasoning: '',
            toolCalls: [],
            model: 'writer-model',
            stopReason: 'stop'
        },
        ...fields
    }) as unknown as HarnessEvent;

const wakeupWith = (fields: Record<string, unknown>): HarnessEvent =>
    ({
        type: 'wakeup',
        agent: 'writer',
        reason: 'pending-tools',
        pending: [],
        ...fields
    }) as unknown as HarnessEvent;

describe('background tool fields (R6)', () => {
    it('reads a pending list from a tool result, and keeps absence distinct from empty', () => {
        expect(pendingOf(resultWith({ pending: pendingTools }))).toEqual(pendingTools);
        expect(pendingOf(resultWith({ pending: [] }))).toEqual([]);
        // Absent field: undefined, NOT [] — only a present array may clear a
        // pending line the UI is already showing.
        expect(pendingOf(resultWith({}))).toBeUndefined();
    });

    it('reads a pending list from a done event', () => {
        expect(pendingOf(doneWith({ pending: [pendingTools[0]] }))).toEqual([pendingTools[0]]);
        expect(pendingOf(doneWith({}))).toBeUndefined();
    });

    it('drops malformed pending entries instead of rendering them', () => {
        expect(
            pendingOf(
                resultWith({
                    pending: [
                        { callId: '', name: 'x', elapsedMs: 1 },
                        { callId: 'c1', name: '', elapsedMs: 1 },
                        { callId: 'c2', name: 'y', elapsedMs: -1 },
                        { callId: 'c3', name: 'z', elapsedMs: 'soon' },
                        null,
                        'nope',
                        { callId: 'c4', name: 'kept', elapsedMs: 0 }
                    ]
                })
            )
        ).toEqual([{ callId: 'c4', name: 'kept', elapsedMs: 0 }]);
    });

    it('ignores a pending list on an event that cannot carry one', () => {
        expect(pendingOf({ type: 'text', agent: 'writer', delta: 'x' })).toBeUndefined();
    });

    it('reads the authoritative tool duration only where it exists', () => {
        expect(toolDurationOf(resultWith({ durationMs: 1500 }))).toBe(1500);
        expect(toolDurationOf(resultWith({ durationMs: 0 }))).toBe(0);
        expect(toolDurationOf(resultWith({}))).toBeUndefined();
        expect(toolDurationOf(resultWith({ durationMs: -5 }))).toBeUndefined();
        expect(toolDurationOf(resultWith({ durationMs: 'soon' }))).toBeUndefined();
        // `done` carries no per-call duration.
        expect(toolDurationOf(doneWith({ durationMs: 1500 }))).toBeUndefined();
    });

    it('accepts a wakeup only when its required pending list is usable', () => {
        expect(wakeupOf(wakeupWith({ pending: [pendingTools[0]] }))).toEqual({
            type: 'wakeup',
            agent: 'writer',
            reason: 'pending-tools',
            pending: [pendingTools[0]]
        });

        // A present-but-empty list IS a valid "everything settled" wake.
        expect(wakeupOf(wakeupWith({ pending: [] }))).toEqual({
            type: 'wakeup',
            agent: 'writer',
            reason: 'pending-tools',
            pending: []
        });

        // `pending` is REQUIRED: absence is malformed and must be NO UPDATE, never
        // normalised to [] (which would clear a line and claim completion).
        expect(wakeupOf(wakeupWith({ pending: undefined }))).toBeUndefined();

        // A non-empty array with no valid entry is malformed too.
        expect(wakeupOf(wakeupWith({ pending: [{ callId: '', name: '', elapsedMs: -1 }] }))).toBeUndefined();

        // Malformed: no agent means the frame cannot be attributed to a section.
        expect(wakeupOf(wakeupWith({ agent: '' }))).toBeUndefined();
        expect(wakeupOf(resultWith({}))).toBeUndefined();
    });
});
