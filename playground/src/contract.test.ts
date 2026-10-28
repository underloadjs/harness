// Contract accessors: descriptor extensions, timings and aliases.
//
// Every helper has a documented fallback for an older server, which is what keeps
// the playground bootable while the backend contract lands. These tests pin the
// fallbacks as exact values so a later "cleanup" cannot silently start guessing.

import type {
    HarnessDescriptor,
    HarnessEvent,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../../server/protocol';
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
    frozenDefinitionOf,
    membersOf,
    modelsForMembers,
    primaryOf,
    subagentsOf,
    uniqueNames
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

    it('defaults editable to true and only honours an explicit false', () => {
        expect(editableOf(descriptor())).toBe(true);
        expect(editableOf(descriptor({ editable: true }))).toBe(true);
        expect(editableOf(descriptor({ editable: false }))).toBe(false);
        expect(builtinOf(descriptor({ builtin: true }))).toBe(true);
        expect(builtinOf(descriptor())).toBe(false);
    });

    it('shows only the harness core set, adding delegate when applicable', () => {
        expect(coreToolsOf(descriptor({ coreTools: ['toolRequest', 'fileRead', 'toolCreate'] }), 1)).toEqual([
            'toolRequest',
            'toolCreate',
            'todoManage'
        ]);
        expect(coreToolsOf(descriptor(), 2)).toEqual([
            'toolRequest',
            'toolCreate',
            'todoManage',
            'agentDelegate'
        ]);
        expect(
            coreToolsOf(descriptor({ coreTools: ['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate'] }), 1)
        ).toEqual(['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate']);
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
