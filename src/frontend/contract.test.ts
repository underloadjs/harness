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
    agentColorsOf,
    agentInstructionsOf,
    agentModelsOf,
    agentsFromDescriptors,
    attemptCommitOf,
    builtinOf,
    callIdOf,
    canonicalHarnessName,
    colorsForMembers,
    coreToolsOf,
    editableOf,
    eventTimesOf,
    frameAtOf,
    frameUsageOf,
    frozenDefinitionOf,
    // The exported core-name/hint constants the coreToolsOf fallback is built from.
    HARNESS_CORE_TOOL_DESCRIPTIONS,
    HARNESS_CORE_TOOL_NAMES,
    instructionsForMembers,
    membersOf,
    modelsForMembers,
    pendingOf,
    primaryOf,
    retryOf,
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
                    coreTools: ['read', 'write', 'edit', 'glob', 'search', 'toolRequest']
                }),
                1
            )
        ).toEqual(['read', 'write', 'edit', 'glob', 'search', 'toolRequest']);

        // An older server with no `coreTools`: the harness-owned core fallback
        // (toolRequest + task), adding delegate when the local team has a second
        // member. R9-R11: the special tools a session ENABLES (toolList, toolManage,
        // toolRegistry, toolCreate, the story tools, agentManage/agentResult,
        // actionRequest, threadFork) are deliberately absent, so an old payload never
        // reports every runtime tool as core.
        expect(coreToolsOf(descriptor(), 2)).toEqual(['toolRequest', 'tasks', 'delegate']);
        expect(coreToolsOf(descriptor(), 1)).toEqual(['toolRequest', 'tasks']);

        // The exported constants are the same list the fallback renders, so a caller
        // that only needs the names cannot drift from it. R9-R11 renamed the wire tool
        // `todoManage` → `task`; the legacy name is asserted here as a string literal
        // (not a rewritten fixture) because its absence IS the contract.
        expect([...HARNESS_CORE_TOOL_NAMES]).toEqual(['toolRequest', 'tasks']);
        expect(Object.keys(HARNESS_CORE_TOOL_DESCRIPTIONS)).not.toContain('todoManage');
        expect(HARNESS_CORE_TOOL_DESCRIPTIONS.tasks).toBe(
            'Read, add, patch, or remove the task list for this chat.'
        );
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
                name: 'read',
                content: 'x',
                isError: false,
                callId: 'c1'
            } as HarnessEvent)
        ).toBe('c1');
        expect(
            callIdOf({ type: 'tool_result', agent: 'a', name: 'read', content: 'x', isError: false })
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

// T3 editable configuration: the UI's sibling accessors. An override map is optional,
// and the effective instruction is `override ?? trusted preset text` — a missing key
// is never an empty prompt.
describe('per-agent instructions', () => {
    it('reads only non-blank string overrides from a descriptor map', () => {
        expect(
            agentInstructionsOf(
                descriptor({
                    agentInstructions: { instruct: 'Lead with the answer.', helper: '   ', bad: 7 }
                })
            )
        ).toEqual({ instruct: 'Lead with the answer.' });
        // A map-less descriptor is the normal "every agent runs its preset text" shape.
        expect(agentInstructionsOf(descriptor())).toEqual({});
        // A malformed map must not throw at render time.
        expect(agentInstructionsOf({ agentInstructions: [] } as never)).toEqual({});
        expect(agentInstructionsOf({ agentInstructions: null } as never)).toEqual({});
    });

    it('filters a map to the resulting members and preserves member order', () => {
        const current = { instruct: 'A.', helper: 'B.', critic: 'C.' };

        // Removal drops the removed member's override; a PATCH sends the complete map.
        expect(instructionsForMembers(current, ['instruct', 'critic'])).toEqual({
            instruct: 'A.',
            critic: 'C.'
        });
        expect(instructionsForMembers(current, ['critic', 'instruct'])).toEqual({
            critic: 'C.',
            instruct: 'A.'
        });
        // A blank value is not an override, so it never reaches the request body.
        expect(instructionsForMembers({ instruct: '  ' }, ['instruct'])).toEqual({});
        expect(instructionsForMembers(current, [])).toEqual({});
    });
});

// T4 (R2/R3): the identity-COLOUR accessors, the third sibling of the two above. What the
// shell paints is `configured hex` when the map names the agent and the deterministic
// palette tone when it does not, so the two facts this pins are exactly (a) which entries
// count as a configured colour and (b) that a value is passed through untouched — a
// re-cased or re-formatted hex would be a colour the reader did not choose.
describe('per-agent identity colours', () => {
    it('reads only non-blank string colours from a descriptor map', () => {
        expect(
            agentColorsOf(
                descriptor({
                    agentColors: { instruct: '#ff6600', helper: '', blank: '   ', bad: 7, missing: undefined }
                })
            )
        ).toEqual({ instruct: '#ff6600' });
        // A map-less descriptor is the normal "every agent gets its own derived tone" shape.
        expect(agentColorsOf(descriptor())).toEqual({});
    });

    it('keeps the configured spelling verbatim, including case and surrounding space', () => {
        // Not a typo: `agent-color.ts` trims and parses for itself, and its contract is that
        // the CSS receives the CALLER's string. Normalising here would silently recolour a
        // value the reader typed (and break the assertion its own tests pin).
        expect(
            agentColorsOf({
                agentColors: { instruct: ' #F97316 ', summarizer: '#4ade80' }
            } as never)
        ).toEqual({ instruct: ' #F97316 ', summarizer: '#4ade80' });
    });

    it('refuses a malformed map instead of throwing at render time', () => {
        expect(agentColorsOf({ agentColors: [] } as never)).toEqual({});
        expect(agentColorsOf({ agentColors: null } as never)).toEqual({});
        expect(agentColorsOf({ agentColors: 'instruct' } as never)).toEqual({});
        expect(agentColorsOf({} as never)).toEqual({});
    });

    it('ignores a colour that resolves through the prototype, not as an own entry', () => {
        // `Object.entries` enumerates own keys only, but the accessor states the rule so an
        // object built outside JSON (a Proxy or a class instance off a double) cannot smuggle
        // an inherited hex into a surface the harness never configured.
        const inherited = Object.create({ legacy: '#000000' }) as Record<string, string>;
        inherited.instruct = '#ff6600';

        expect(agentColorsOf({ agentColors: inherited })).toEqual({ instruct: '#ff6600' });
    });

    it('filters a colour map to the resulting members and preserves member order', () => {
        const current = { instruct: '#ff6600', helper: '#22d3ee', critic: '#a78bfa' };

        // Removal drops the removed member's colour: the server REPLACES `agent_colors` with
        // whatever a PATCH names, so the complete current map has to travel.
        expect(colorsForMembers(current, ['instruct', 'critic'])).toEqual({
            instruct: '#ff6600',
            critic: '#a78bfa'
        });
        // Member order, not map order.
        expect(Object.keys(colorsForMembers(current, ['critic', 'instruct']))).toEqual([
            'critic',
            'instruct'
        ]);
        // A blank value is not a colour, and a member the map omits stays uncoloured.
        expect(colorsForMembers({ instruct: '  ' }, ['instruct'])).toEqual({});
        expect(colorsForMembers(current, ['ghost'])).toEqual({});
        expect(colorsForMembers(current, [])).toEqual({});
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
    { callId: 'c1', name: 'read', elapsedMs: 1200 },
    { callId: 'c2', name: 'search', elapsedMs: 900 }
];

const resultWith = (fields: Record<string, unknown>): HarnessEvent =>
    ({
        type: 'tool_result',
        agent: 'writer',
        name: 'read',
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

// R1/R4: a retried model request must be renderable from its frame alone, and a
// malformed frame must render NOTHING rather than a fabricated "retry 0 in 0ms".
describe('model-request retries (R1)', () => {
    const retryWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
        ({
            type: 'retry',
            agent: 'writer',
            attempt: 1,
            maxAttempts: 11,
            delayMs: 1_000,
            error: { message: 'HTTP 500: overloaded' },
            ...fields
        }) as unknown as HarnessEvent;

    it('accepts a well-formed retry frame unchanged', () => {
        expect(retryOf(retryWith())).toEqual({
            type: 'retry',
            agent: 'writer',
            attempt: 1,
            maxAttempts: 11,
            delayMs: 1_000,
            error: { message: 'HTTP 500: overloaded' }
        });
    });

    it('rejects a frame that says nothing usable about the sequence', () => {
        expect(retryOf(retryWith({ agent: '' }))).toBeUndefined();
        expect(retryOf(retryWith({ attempt: 0 }))).toBeUndefined();
        expect(retryOf(retryWith({ attempt: undefined }))).toBeUndefined();
        expect(retryOf(retryWith({ attempt: 'one' }))).toBeUndefined();
        // A budget smaller than the failed attempt is incoherent.
        expect(retryOf(retryWith({ maxAttempts: 0 }))).toBeUndefined();
        expect(retryOf(retryWith({ delayMs: -1 }))).toBeUndefined();
        expect(retryOf(retryWith({ delayMs: undefined }))).toBeUndefined();
        expect(retryOf(retryWith({ error: undefined }))).toBeUndefined();
        // Every other event type is not a retry.
        expect(retryOf(resultWith({}))).toBeUndefined();
        expect(retryOf(wakeupWith())).toBeUndefined();
    });
});

// R3/F1: the per-request SUCCESS boundary. It is the frame a consumer needs to stop
// discarding output, because the harness emits `done` only for a tool-free response
// (so a committed tool round has no `done` at all).
describe('model-request success boundary (R3)', () => {
    const commitWith = (fields: Record<string, unknown> = {}): HarnessEvent =>
        ({
            type: 'attempt_commit',
            agent: 'writer',
            attempt: 1,
            maxAttempts: 11,
            ...fields
        }) as unknown as HarnessEvent;

    it('accepts a well-formed commit frame unchanged', () => {
        expect(attemptCommitOf(commitWith())).toEqual({
            type: 'attempt_commit',
            agent: 'writer',
            attempt: 1,
            maxAttempts: 11
        });
        // A later successful attempt is equally valid.
        expect(attemptCommitOf(commitWith({ attempt: 3 }))).toEqual({
            type: 'attempt_commit',
            agent: 'writer',
            attempt: 3,
            maxAttempts: 11
        });
    });

    it('rejects a frame that cannot name a committed attempt', () => {
        expect(attemptCommitOf(commitWith({ agent: '' }))).toBeUndefined();
        expect(attemptCommitOf(commitWith({ attempt: 0 }))).toBeUndefined();
        expect(attemptCommitOf(commitWith({ attempt: undefined }))).toBeUndefined();
        expect(attemptCommitOf(commitWith({ attempt: Number.NaN }))).toBeUndefined();
        // A budget below the attempt it reports is incoherent.
        expect(attemptCommitOf(commitWith({ attempt: 5, maxAttempts: 2 }))).toBeUndefined();
        expect(attemptCommitOf(commitWith({ maxAttempts: undefined }))).toBeUndefined();
        // Every other event type is not a boundary.
        expect(attemptCommitOf(resultWith({}))).toBeUndefined();
        expect(attemptCommitOf(wakeupWith())).toBeUndefined();
    });
});
