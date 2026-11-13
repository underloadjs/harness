// toolRequest selection at the harness level.
//
// Contract pinned here:
//   - exact `names`, name `regex`, and `tags` are OR-ed into one UNCAPPED union
//     (the selector returns every match; the harness applies maxEnabledTools);
//   - exact names keep caller order; tag ranking stays best-score-first;
//   - `limit` narrows only the current query, while `maxEnabledTools` bounds the
//     persistent enabled searchable set and never counts core tools;
//   - `matched` is the whole union, `enabled`/`tools` are what the bound admitted,
//     and `omitted` is the exact difference (no arbitrary five-result cap);
//   - an empty query enables nothing and returns the catalogue vocabulary;
//   - repeated queries are idempotent (there is no legacy paging offset), and
//     reset() forgets the enabled set.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream): ReturnType<typeof agent> =>
    agent({ model: 'merge/ds4-flash', stream });

// Eight searchable fixtures that all carry the exact tag "widgets", named so the
// deterministic name-order tiebreak decides the selected order.
const fixtures = (count: number) =>
    Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
            const name = `file-${String(index).padStart(2, '0')}`;
            return [
                name,
                tool({ name, description: `${name} fixture.`, tags: ['widgets'], execute: () => name })
            ];
        })
    );

const matchOf = (name: string) => ({
    name,
    description: `${name} fixture.`,
    tags: ['widgets']
});

describe('toolRequest selection', () => {
    it('returns the whole tag union in one call with no five-result cap', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["widgets"]}'),
                callTool('c2', 'toolRequest', '{"tags":["widgets"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');

        const names = Array.from({ length: 8 }, (_, index) => `file-${String(index).padStart(2, '0')}`);
        const expected = {
            enabled: names,
            tools: names.map(matchOf),
            matched: 8,
            omitted: 0
        };

        // No paging and no cap: all eight, then the identical query is idempotent.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual(expected);
        expect(JSON.parse((entry.messages[4] as { content: string }).content)).toEqual(expected);
        expect(writer.discoveredTools).toEqual(names);
    });

    it('selects exact names in caller order and regex names', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"names":["file-05","file-00"]}'),
                callTool('c2', 'toolRequest', '{"regex":"^file-0[12]$"}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');

        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: ['file-05', 'file-00'],
            tools: ['file-05', 'file-00'].map(matchOf),
            matched: 2,
            omitted: 0
        });
        expect(JSON.parse((entry.messages[4] as { content: string }).content)).toEqual({
            enabled: ['file-01', 'file-02'],
            tools: ['file-01', 'file-02'].map(matchOf),
            matched: 2,
            omitted: 0
        });
        // Newest selector matches lead; prior entries fill remaining capacity.
        expect(writer.discoveredTools).toEqual([
            'file-01',
            'file-02',
            'file-05',
            'file-00'
        ]);
    });

    it('narrows one query with limit without making it a global cap', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["widgets"],"limit":3}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');

        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: ['file-00', 'file-01', 'file-02'],
            tools: ['file-00', 'file-01', 'file-02'].map(matchOf),
            matched: 8,
            omitted: 5
        });
        // The per-query limit did not enter the persistent enabled set beyond three.
        expect(writer.discoveredTools).toEqual(['file-00', 'file-01', 'file-02']);
    });

    it('bounds the enabled searchable set with maxEnabledTools and excludes core tools', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["tools"]}'),
                answer('done')
            ])
        );
        // These fixtures carry the same "tools" tag as the harness-owned core
        // tools, deliberately: core tools must be reported, never enabled, and
        // never counted against the searchable bound.
        const definitions = Object.fromEntries(
            Array.from({ length: 5 }, (_, index) => {
                const name = `file-${String(index).padStart(2, '0')}`;
                return [
                    name,
                    tool({
                        name,
                        description: `${name} fixture.`,
                        tags: ['tools'],
                        execute: () => name
                    })
                ];
            })
        );
        const writer = harness({
            agents: { writer: entry },
            tools: definitions,
            presets: false,
            maxEnabledTools: 2
        });

        await writer('go');

        const result = JSON.parse((entry.messages[2] as { content: string }).content);

        // Five searchable fixture matches, only the first two admitted.
        expect(result.enabled).toEqual(['file-00', 'file-01']);
        expect(result.tools).toEqual([
            { name: 'file-00', description: 'file-00 fixture.', tags: ['tools'] },
            { name: 'file-01', description: 'file-01 fixture.', tags: ['tools'] }
        ]);
        // R9-R11: five searchable fixtures plus the five demoted runtime rows that
        // carry the "tools" tag (toolRegistry, toolList, toolManage, toolCreate,
        // threadFork) match, and maxEnabledTools admits only the first two. Only
        // toolRequest is still declared core, so it is the single already-available
        // report — reported, never enabled, never counted against the bound.
        expect(result.matched).toBe(10);
        expect(result.omitted).toBe(8);
        expect(result.alreadyAvailable.map((match: { name: string }) => match.name)).toEqual([
            'toolRequest'
        ]);
        expect(writer.discoveredTools).toEqual(['file-00', 'file-01']);
    });

    it('defaults the enabled searchable bound to 32', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["widgets"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(33), presets: false });

        await writer('go');

        const result = JSON.parse((entry.messages[2] as { content: string }).content);
        const admitted = Array.from(
            { length: 32 },
            (_, index) => `file-${String(index).padStart(2, '0')}`
        );

        expect(result.enabled).toEqual(admitted);
        expect(result.tools.map((match: { name: string }) => match.name)).toEqual(admitted);
        expect(result.matched).toBe(33);
        expect(result.omitted).toBe(1);
        expect(writer.discoveredTools).toEqual(admitted);
    });

    it('switches the capped set from tags, regex, and exact names in newest-first order', async () => {
        const definitions = Object.fromEntries(
            ['alpha', 'beta', 'gamma'].flatMap((group) =>
                ['0', '1'].map((suffix) => {
                    const name = `${group}-${suffix}`;
                    return [
                        name,
                        tool({
                            name,
                            description: `${name} fixture.`,
                            tags: ['group', group],
                            execute: () => name
                        })
                    ];
                })
            )
        );
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["group"]}'),
                callTool('c2', 'toolRequest', '{"tags":["beta"]}'),
                callTool('c3', 'toolRequest', '{"regex":"^gamma"}'),
                callTool('c4', 'toolRequest', '{"names":["alpha-1","alpha-0"]}'),
                answer('done')
            ])
        );
        const writer = harness({
            agents: { writer: entry },
            tools: definitions,
            presets: false,
            maxEnabledTools: 2
        });

        await writer('go');

        const content = (index: number) =>
            JSON.parse((entry.messages[index] as { content: string }).content);

        // Over-cap request: all six matches are reported, only the first two fit.
        expect(content(2)).toEqual({
            enabled: ['alpha-0', 'alpha-1'],
            tools: [
                { name: 'alpha-0', description: 'alpha-0 fixture.', tags: ['group', 'alpha'] },
                { name: 'alpha-1', description: 'alpha-1 fixture.', tags: ['group', 'alpha'] }
            ],
            matched: 6,
            omitted: 4
        });

        // Tag switching evicts BOTH older tools.
        expect(content(4)).toEqual({
            enabled: ['beta-0', 'beta-1'],
            tools: [
                { name: 'beta-0', description: 'beta-0 fixture.', tags: ['group', 'beta'] },
                { name: 'beta-1', description: 'beta-1 fixture.', tags: ['group', 'beta'] }
            ],
            matched: 2,
            omitted: 0,
            evicted: ['alpha-0', 'alpha-1']
        });

        // Regex switching follows the same rule.
        expect(content(6)).toEqual({
            enabled: ['gamma-0', 'gamma-1'],
            tools: [
                { name: 'gamma-0', description: 'gamma-0 fixture.', tags: ['group', 'gamma'] },
                { name: 'gamma-1', description: 'gamma-1 fixture.', tags: ['group', 'gamma'] }
            ],
            matched: 2,
            omitted: 0,
            evicted: ['beta-0', 'beta-1']
        });

        // Exact names keep caller order and replace the previous toolset.
        expect(content(8)).toEqual({
            enabled: ['alpha-1', 'alpha-0'],
            tools: [
                { name: 'alpha-1', description: 'alpha-1 fixture.', tags: ['group', 'alpha'] },
                { name: 'alpha-0', description: 'alpha-0 fixture.', tags: ['group', 'alpha'] }
            ],
            matched: 2,
            omitted: 0,
            evicted: ['gamma-0', 'gamma-1']
        });
        expect(writer.discoveredTools).toEqual(['alpha-1', 'alpha-0']);
    });

    it('keeps declarations and authorization on the same capped current set', async () => {
        const definitions = Object.fromEntries(
            ['alpha', 'beta'].flatMap((group) =>
                ['0', '1'].map((suffix) => {
                    const name = `${group}-${suffix}`;
                    return [
                        name,
                        tool({
                            name,
                            description: `${name} fixture.`,
                            tags: [group],
                            execute: () => name
                        })
                    ];
                })
            )
        );
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["alpha"]}'),
                    callTool('c2', 'toolRequest', '{"tags":["beta"]}'),
                    callTool('c3', 'alpha-0', '{}'),
                    answer('recovered')
                ],
                seen
            )
        );
        const writer = harness({
            agents: { writer: entry },
            tools: definitions,
            presets: false,
            maxEnabledTools: 2
        });

        await writer('go');

        // The request after the beta switch declares beta only.
        expect(
            (seen[2].tools ?? [])
                .map((declaration) => declaration.name)
                .filter((name) => name.startsWith('alpha') || name.startsWith('beta'))
        ).toEqual(['beta-0', 'beta-1']);

        // The evicted alpha definition exists in the registry but is no longer
        // authorized, so the model call becomes a readable rejection.
        const rejected = writer.agents.writer.messages.find(
            (message) => message.role === 'tool' && message.toolCallId === 'c3'
        );
        expect(rejected?.content).toContain(
            'Tool "alpha-0" is registered but not enabled yet.'
        );
        expect(writer.discoveredTools).toEqual(['beta-0', 'beta-1']);
    });

    it('applies same-turn toolRequest calls in invocation order, then authorizes against the result', async () => {
        const definitions = Object.fromEntries(
            ['alpha', 'beta'].flatMap((group) =>
                ['0', '1'].map((suffix) => {
                    const name = `${group}-${suffix}`;
                    return [
                        name,
                        tool({
                            name,
                            description: `${name} fixture.`,
                            tags: [group],
                            execute: () => name
                        })
                    ];
                })
            )
        );
        const entry = brain(
            scripted([
                // One assistant turn, three calls. toolRequest mutates the set
                // synchronously at launch, so launch order is the effective order.
                [
                    { type: 'done', stopReason: 'tool_calls', toolCalls: [
                        { id: 'c1', name: 'toolRequest', arguments: '{"tags":["alpha"]}' },
                        { id: 'c2', name: 'toolRequest', arguments: '{"tags":["beta"]}' },
                        { id: 'c3', name: 'alpha-0', arguments: '{}' }
                    ] }
                ],
                answer('done')
            ])
        );
        const writer = harness({
            agents: { writer: entry },
            tools: definitions,
            presets: false,
            maxEnabledTools: 2
        });

        await writer('go');

        // The later toolRequest won the slots; the first one's tools were evicted.
        expect(writer.discoveredTools).toEqual(['beta-0', 'beta-1']);
        expect(JSON.parse((entry.messages[3] as { content: string }).content)).toEqual({
            enabled: ['beta-0', 'beta-1'],
            tools: [
                { name: 'beta-0', description: 'beta-0 fixture.', tags: ['beta'] },
                { name: 'beta-1', description: 'beta-1 fixture.', tags: ['beta'] }
            ],
            matched: 2,
            omitted: 0,
            evicted: ['alpha-0', 'alpha-1']
        });

        // c3 ran after both toolRequest calls: alpha-0 is registered but no longer
        // in the capped set, so authorization rejects it.
        expect((entry.messages[4] as { content: string }).content).toBe(
            'Tool "alpha-0" is registered but not enabled yet. Call toolRequest with tags like "alpha" to enable it.'
        );
    });

    it('enforces maxEnabledTools on restore and declares only the retained newest set', async () => {
        const definitions = Object.fromEntries(
            ['alpha', 'beta', 'gamma', 'delta'].flatMap((group) =>
                ['0', '1'].map((suffix) => {
                    const name = `${group}-${suffix}`;
                    return [
                        name,
                        tool({
                            name,
                            description: `${name} fixture.`,
                            tags: ['all', group],
                            execute: () => name
                        })
                    ];
                })
            )
        );

        const source = harness({
            agents: { writer: brain(scripted([answer('source')])) },
            tools: definitions,
            presets: false,
            maxEnabledTools: 2
        });
        await source.executeTool('toolRequest', { tags: ['all'] });
        const snapshot = JSON.parse(JSON.stringify(source.snapshot())) as HarnessSnapshot;

        // A legacy/edited snapshot can name more than the current cap; restore must
        // retain the leading (newest) entries and drop the overflow.
        snapshot.discovery.enabled = ['delta-0', 'delta-1', 'gamma-0'];
        const seen: HarnessStreamRequest[] = [];
        const target = harness({
            agents: { writer: brain(scripted([answer('restored')], seen)) },
            tools: definitions,
            presets: false,
            maxEnabledTools: 2
        });
        target.restore(snapshot);

        expect(target.discoveredTools).toEqual(['delta-0', 'delta-1']);
        await target('continue');

        expect(
            (seen[0].tools ?? [])
                .map((declaration) => declaration.name)
                .filter((name) => name.startsWith('delta') || name.startsWith('gamma'))
        ).toEqual(['delta-0', 'delta-1']);
    });

    it('returns the catalogue vocabulary for an empty query and forgets state on reset()', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{}'),
                callTool('c2', 'toolRequest', '{"tags":["widgets"]}'),
                answer('first'),
                callTool('c3', 'toolRequest', '{"tags":["widgets"]}'),
                answer('second')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(2), presets: false });

        await writer('go');

        // R9-R11: an empty query reports the whole searchable vocabulary. Besides
        // the two 'widgets' fixtures, that is the tag union of the eleven demoted
        // runtime rows (toolRegistry, toolList, toolManage, toolCreate,
        // profileManage, chapterManage, locationManage, agentManage, agentResult,
        // actionRequest, threadFork); the declared core pair contributes nothing.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: [],
            tools: [],
            matched: 0,
            omitted: 0,
            availableTags: [
                'agents',
                'answer',
                'branch',
                'catalogue',
                'chapter',
                'chapters',
                'character',
                'characters',
                'compile',
                'create',
                'define',
                'dynamic',
                'edit',
                'entries',
                'extension',
                'fork',
                'history',
                'inspect',
                'inventory',
                'list',
                'location',
                'locations',
                'manage',
                'outline',
                'output',
                'people',
                'person',
                'place',
                'places',
                'preview',
                'profile',
                'profiles',
                'record',
                'records',
                'registry',
                'reload',
                'research',
                'result',
                'results',
                'scene',
                'self-modifying',
                'setting',
                'settings',
                'source',
                'store',
                'story',
                'subagent',
                'summarize',
                'team',
                'thread',
                'tools',
                'widgets',
                'world',
                'writing'
            ]
        });
        expect(writer.discoveredTools).toEqual(['file-00', 'file-01']);

        writer.reset();
        await writer('again');

        // After reset the same query enables the tools again, in name order.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: ['file-00', 'file-01'],
            tools: ['file-00', 'file-01'].map(matchOf),
            matched: 2,
            omitted: 0
        });
    });
});

// ---------------------------------------------------------------------------
// R1 — the opt-in FULL-TOOLBOX SEED, and the switchability view that decides it.
//
// `configuration.enableAllTools` (src/types/index.ts) is what a host sets so a brand-new
// conversation starts with every SWITCHABLE tool enabled instead of making the model spend a
// discovery round trip to reach its own toolbox. Two rules matter and both live in the kernel,
// which is why they are pinned here rather than in a server projection:
//   - WHICH names the seed admits is `occupiesSearchableSlot`, the same predicate
//     `toolManage enable|disable` refuses with — NOT a catalogue-visibility guess. A
//     visibility-only reimplementation gets both directions wrong: `toolCancel` is demoted to
//     `visibility: 'searchable'` at registration yet stays pending-only (never seedable, never
//     switchable), while `file-00`/`threadFork` look runtime-ish and genuinely ARE switchable;
//   - the seed is a pass through `enableTools`, so `maxEnabledTools` still bounds it and the
//     host's global tool switch still wins: an over-cap or disabled name is left OFF, reported
//     by the rows, never an error.
//
// The library default is unchanged and asserted first: a consumer that does not pass the flag
// gets an empty enabled set, exactly as before.
// ---------------------------------------------------------------------------

// The twelve names this fixture registers that MAY occupy an enabled slot, in
// registration order: the eleven demoted runtime rows (no `interaction` is configured, so
// `actionRequest` is not registered) plus the two 'widgets' fixtures. `toolRequest`/`tasks`
// (core) and `toolCancel` (pending-only) are deliberately absent.
const SEEDABLE_RUNTIME_NAMES = [
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
    'threadFork'
];

const seedOf = (names: string[]): string[] => [...SEEDABLE_RUNTIME_NAMES, ...names];

describe('configuration.enableAllTools — starting with the whole switchable toolbox', () => {
    it('leaves the enabled set empty when the host does not ask for the seed', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(2),
            presets: false
        });

        // The library default, byte for byte: discovery is still the only way a searchable
        // name gets switched on.
        expect(writer.discoveredTools).toEqual([]);
    });

    it('enables every switchable name in registration order, and no core or pending-only one', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')], seen)) },
            tools: fixtures(2),
            presets: false,
            enableAllTools: true
        });

        expect(writer.discoveredTools).toEqual(seedOf(['file-00', 'file-01']));

        // THE SEED IS REAL, NOT A FIGURE: the first model request is declared from this state,
        // so the conversation starts able to call its own tools. A core name is declared
        // without ever entering the enabled set, and the pending-only `toolCancel` appears in
        // neither place until it is actionable.
        await writer('go');

        const declared = (seen[0].tools ?? []).map((declaration) => declaration.name);

        expect(declared).toEqual([
            'toolRequest',
            'tasks',
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
            'threadFork',
            'file-00',
            'file-01'
        ]);
        expect(declared).not.toContain('toolCancel');
    });

    it('skips every name the host has switched off globally, so a disabled name costs no slot', () => {
        const denied = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(2),
            presets: false,
            enableAllTools: true,
            // Two names, two different shapes: an ordinary fixture and a runtime row. Neither
            // may be seeded — `enableTools` does not consult the provider, so a seed that
            // ignored it would fill cap slots with tools the operator disabled for everyone.
            toolSettings: { isToolDisabled: (name: string) => name === 'file-01' || name === 'records' }
        });

        expect(denied.discoveredTools).toEqual(
            seedOf(['file-00']).filter((name) => name !== 'records')
        );
    });

    it('keeps the maxEnabledTools bound and leaves the overflow off instead of throwing', () => {
        const capped = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(2),
            presets: false,
            enableAllTools: true,
            maxEnabledTools: 3
        });

        // Registration order decides who gets a slot, and the rest simply stays off — the same
        // `omitted` outcome a `toolRequest` match beyond the cap gets. "Everything enabled" is
        // therefore representable up to the bound, and a catalogue larger than the bound
        // reports the truth through the rows rather than failing construction.
        expect(capped.discoveredTools).toEqual(['toolRegistry', 'toolList', 'toolManage']);
    });
});

describe("harness.isToolSwitchable — the kernel's own answer to \"may this be switched?\"", () => {
    it('refuses core and pending-only names, admits searchable ones, and an unknown name is not switchable', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(2),
            presets: false
        });

        // A fixture the harness registered and that is not core: switchable.
        expect(writer.isToolSwitchable('file-00')).toBe(true);

        // The declared core pair: always in context, never a cap slot, so switching is a no-op
        // the caller would believe took effect — the kernel refuses it.
        expect(writer.isToolSwitchable('toolRequest')).toBe(false);
        expect(writer.isToolSwitchable('tasks')).toBe(false);

        // THE CASE A SERVER-SIDE GUESS GETS WRONG: `toolCancel` reports `visibility:
        // 'searchable'` (its registration demotes it so `toolList`/details stay honest), so a
        // rule rebuilt from visibility alone would call it switchable and offer a checkbox the
        // runtime then refuses. The pending-only marker is the difference, and this predicate
        // is the only place that marker is read.
        expect(writer.tools.toolCancel.visibility).toBe('searchable');
        expect(writer.isToolSwitchable('toolCancel')).toBe(false);

        // Not registered at all (a name this harness never holds, e.g. `delegate` without a
        // subagent team, or `search` without a provider key) is likewise not switchable.
        expect(writer.isToolSwitchable('delegate')).toBe(false);
        expect(writer.isToolSwitchable('nope')).toBe(false);
    });

    it('answers live: a tool registered after construction becomes switchable at once', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(1),
            presets: false
        });

        expect(writer.isToolSwitchable('late')).toBe(false);

        await writer.createTool({
            name: 'late',
            description: 'Registered after construction.',
            tags: ['late'],
            source: 'return 1;'
        });

        expect(writer.isToolSwitchable('late')).toBe(true);
        // A created tool is enabled by the same kernel, and stays switchable afterwards.
        expect(writer.discoveredTools).toContain('late');
    });
});
