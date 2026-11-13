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

    // THE SESSION SWITCH REDRAWS THIS SEAM'S MEANING, and the pin below is the proof that
    // it did not move: `isToolSwitchable` is the CAP-SLOT predicate, and it is still false
    // for every name that cannot hold one. What changed is that it is no longer the bar for
    // switching — the enable/disable operations accept any registered name now, and a core
    // or pending-only name's switch lives in `withheldTools`, which this predicate says
    // nothing about. A host that reads `false` as "the user cannot switch this off" is the
    // mistake this comment exists to prevent (the server's `protected` row figure is T6's).
    it('stays the cap-slot predicate while the session switch widens: core and pending-only names switch, slots do not move', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(2),
            presets: false,
            enableAllTools: true
        });

        // The predicate itself: byte-identical to the pre-switch kernel.
        expect(writer.isToolSwitchable('file-00')).toBe(true);
        expect(writer.isToolSwitchable('toolRequest')).toBe(false);
        expect(writer.isToolSwitchable('tasks')).toBe(false);
        expect(writer.isToolSwitchable('toolCancel')).toBe(false);

        const capBefore = writer.discoveredTools;

        // Three names with no cap slot, each a DIFFERENT shape, all switchable now: an
        // always-declared core control, a core record tool, and the pending-only runtime
        // control that reports `visibility: 'searchable'` but is never seedable.
        for (const name of ['toolRequest', 'tasks', 'toolCancel']) {
            expect(writer.runtime.manageTool(undefined, { operation: 'disable', name })).toEqual({
                name,
                operation: 'disable',
                enabled: false,
                changed: true
            });
        }

        // The switch is recorded where a slot cannot be — and the capped set did not move
        // by one name, in either list or order.
        expect(writer.withheldTools).toEqual(['tasks', 'toolCancel', 'toolRequest']);
        expect(writer.discoveredTools).toEqual(capBefore);

        for (const name of ['toolRequest', 'tasks', 'toolCancel']) {
            expect(writer.runtime.manageTool(undefined, { operation: 'enable', name })).toEqual({
                name,
                operation: 'enable',
                enabled: true,
                changed: true
            });
        }

        expect(writer.withheldTools).toEqual([]);
        expect(writer.discoveredTools).toEqual(capBefore);

        // An UNREGISTERED name is still refused, and a blank name still throws: the switch
        // has a bar, it is just registration rather than cap membership.
        expect(() => writer.runtime.manageTool(undefined, { operation: 'disable', name: 'delegate' })).toThrow(
            'Tool "delegate" is not registered in this harness.'
        );
        expect(() => writer.runtime.manageTool(undefined, { operation: 'enable', name: '   ' })).toThrow(
            'Tool "   " is not registered in this harness.'
        );

        // `remove` is the OTHER privilege and keeps its core refusal: switching a harness
        // control off is not the same as unregistering it.
        expect(() => writer.runtime.manageTool(undefined, { operation: 'remove', name: 'toolRequest' })).toThrow(
            'Tool "toolRequest" is a core harness tool and cannot be unregistered.'
        );
    });
});

// ---------------------------------------------------------------------------
// THE SESSION SWITCH — the withheld set (`harness.withheldTools`).
//
// The requirement this block exists for: "all tools can be toggled off... toggling is
// purely for agents/threads of that session, and it can be in real time (when the agent's
// thread is still running)... tools can execute any tools regardless whether they are
// disabled or not... this does not stop the user from triggering those tools through the
// REST API" and "a disabled tool shouldn't even appear in toolRequest — they are simply
// not listed", "the same for when a thread spawns a delegate or another thread", "tool
// control via the tool panel is global session level, affecting all threads".
//
// The kernel's shape, and the four properties that fall out of it:
//   - a SEPARATE set beside `activeTools`, so a switch never spends or frees a cap slot and
//     applies to names that never had one (core, pending-only);
//   - read at the model boundaries — per model turn (declarations) and per launch (the gate),
//     which is what makes it real-time for a running thread, with no rebuild;
//   - consulted by EVERY agent and thread of the session through those shared boundaries
//     (`visibleCoreTools`/`declared` are what a subagent, a fork, and a thread all build
//     their request from), and by the discovery catalogue, which stops `toolRequest`
//     resurrecting a name its user just switched off;
//   - NOT consulted by the execution doors (`executeTool`/`callTool`), which is the REST and
//     nested-tool-call guarantee, unchanged from the discovery contract they already had.
// ---------------------------------------------------------------------------

// The refusal sentence a model gets for a name the conversation switched off. It is the
// kernel's `sessionDisableReason`, pinned here as ONE literal so a wording change is a
// deliberate diff: the sentence has to break the loop ("toolRequest will not find it")
// because the alternative answer — "call toolRequest" — is a promise the kernel no longer
// keeps for this name.
const SWITCHED_OFF = (name: string): string =>
    `Tool "${name}" is switched off for this conversation by its user. Calling toolRequest will not find it and asking again will not change this answer.`;

describe('the conversation tool switch (the withheld set)', () => {
    it('switches a core declaration off and back on mid-conversation, and the NEXT request follows', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            // `ping` is a host-registered CORE tool: always declared, never a cap slot. It
            // is the case the old kernel could not switch at all.
            agents: { writer: brain(scripted([answer('one'), answer('two'), answer('three')], seen)) },
            tools: {
                ...fixtures(1),
                ping: tool({
                    name: 'ping',
                    description: 'Ping.',
                    tags: ['ping'],
                    visibility: 'core',
                    execute: () => 'pong'
                })
            },
            presets: false
        });

        await writer('go');
        expect((seen[0].tools ?? []).map((entry) => entry.name)).toEqual(['toolRequest', 'tasks', 'ping']);

        const capBefore = writer.discoveredTools;
        expect(writer.runtime.manageTool(undefined, { operation: 'disable', name: 'ping' })).toEqual({
            name: 'ping',
            operation: 'disable',
            enabled: false,
            changed: true
        });

        // LIVE, not staged: the next model turn of the SAME running conversation is built
        // from the new state. No re-registration, no rebuild, no cap movement.
        await writer('again');
        expect((seen[1].tools ?? []).map((entry) => entry.name)).toEqual(['toolRequest', 'tasks']);
        expect(writer.withheldTools).toEqual(['ping']);
        expect(writer.discoveredTools).toEqual(capBefore);

        // And the switch is reversible by the same operation, with the same zero cap effect.
        expect(writer.runtime.manageTool(undefined, { operation: 'enable', name: 'ping' })).toEqual({
            name: 'ping',
            operation: 'enable',
            enabled: true,
            changed: true
        });
        await writer('third');
        expect((seen[2].tools ?? []).map((entry) => entry.name)).toEqual(['toolRequest', 'tasks', 'ping']);
        expect(writer.withheldTools).toEqual([]);
        expect(writer.discoveredTools).toEqual(capBefore);
    });

    it('reports a repeat switch as changed:false, and never claims a mutation that did not happen', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true
        });

        const capBefore = writer.discoveredTools;

        expect(writer.runtime.manageTool(undefined, { operation: 'disable', name: 'tasks' })).toEqual({
            name: 'tasks',
            operation: 'disable',
            enabled: false,
            changed: true
        });
        expect(writer.runtime.manageTool(undefined, { operation: 'disable', name: 'tasks' })).toEqual({
            name: 'tasks',
            operation: 'disable',
            enabled: false,
            changed: false
        });
        expect(writer.runtime.manageTool(undefined, { operation: 'enable', name: 'tasks' })).toEqual({
            name: 'tasks',
            operation: 'enable',
            enabled: true,
            changed: true
        });
        expect(writer.runtime.manageTool(undefined, { operation: 'enable', name: 'tasks' })).toEqual({
            name: 'tasks',
            operation: 'enable',
            enabled: true,
            changed: false
        });

        // The same idempotence for a name that DOES hold a slot, on the capped path.
        expect(writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' })).toEqual({
            name: 'file-00',
            operation: 'disable',
            enabled: false,
            changed: true
        });
        expect(writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' })).toEqual({
            name: 'file-00',
            operation: 'disable',
            enabled: false,
            changed: false
        });
        expect(writer.withheldTools).toEqual(['file-00']);
        expect(writer.discoveredTools).toEqual(capBefore.filter((entry) => entry !== 'file-00'));
    });

    it('refuses a withheld name at launch — core, searchable, and each pre-gate runtime control', async () => {
        // A core host tool the model still tries to call after it disappeared from the
        // declaration list.
        let coreRan = false;
        const core = harness({
            agents: {
                writer: brain(scripted([callTool('c1', 'ping', '{}'), answer('recovered')]))
            },
            tools: {
                ping: tool({
                    name: 'ping',
                    description: 'Ping.',
                    tags: ['ping'],
                    visibility: 'core',
                    execute: () => {
                        coreRan = true;
                        return 'pong';
                    }
                })
            },
            presets: false
        });
        core.runtime.manageTool(undefined, { operation: 'disable', name: 'ping' });

        expect((await core('go')).content).toBe('recovered');
        expect(coreRan).toBe(false);
        expect((core.agent.messages[2] as { content: string }).content).toBe(SWITCHED_OFF('ping'));

        // A SEARCHABLE name that also lost its slot: the switch sentence, not the old
        // "not enabled yet. Call toolRequest" one, because toolRequest cannot find it.
        const searchable = harness({
            agents: { writer: brain(scripted([callTool('c1', 'file-00', '{}'), answer('recovered')])) },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true
        });
        searchable.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' });
        await searchable('go');
        expect((searchable.agent.messages[2] as { content: string }).content).toBe(SWITCHED_OFF('file-00'));

        // THE PRE-GATE BRANCHES. `threadFork` and `actionRequest` leave the launcher through
        // their own handlers BEFORE the discovery gate, and `toolCancel` answers from its own
        // acknowledgement branch, so a gate placed only at the discovery check would leave
        // all three switches no-ops. Each is asserted against a control that proves the branch
        // WOULD have run.
        const forkOff = harness({
            agents: { writer: brain(scripted([callTool('c1', 'threadFork', '{"input":"x"}'), answer('recovered')])) },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true
        });
        forkOff.runtime.manageTool(undefined, { operation: 'disable', name: 'threadFork' });
        await forkOff('go');
        expect((forkOff.agent.messages[2] as { content: string }).content).toBe(SWITCHED_OFF('threadFork'));
        // No branch was minted: the refusal replaced the fork.
        expect(forkOff.threads().map((entry) => entry.id)).toEqual(['agent:writer']);

        const forkOn = harness({
            agents: { writer: brain(scripted([callTool('c1', 'threadFork', '{"input":"x"}'), answer('recovered')])) },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true
        });
        await forkOn('go');
        expect(JSON.parse((forkOn.agent.messages[2] as { content: string }).content)).toEqual({
            branchId: 'branch-1',
            threadId: 'branch-1',
            content: 'recovered'
        });

        const actionOff = harness({
            agents: {
                writer: brain(
                    scripted([
                        callTool('c1', 'actionRequest', '{"kind":"confirm","question":"go?"}'),
                        answer('recovered')
                    ])
                )
            },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true,
            interaction: {}
        });
        actionOff.runtime.manageTool(undefined, { operation: 'disable', name: 'actionRequest' });
        await actionOff('go');
        expect((actionOff.agent.messages[2] as { content: string }).content).toBe(SWITCHED_OFF('actionRequest'));

        // `toolCancel` is the pending-only control: withheld, it is neither declared nor
        // runnable even while a sibling call is genuinely in flight.
        const cancelOff = harness({
            agents: {
                writer: brain(
                    scripted([
                        [
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    { id: 'c1', name: 'file-00', arguments: '{}' },
                                    { id: 'c2', name: 'toolCancel', arguments: '"c1"' }
                                ]
                            }
                        ],
                        answer('recovered')
                    ])
                )
            },
            tools: {
                'file-00': tool({
                    name: 'file-00',
                    description: 'file-00 fixture.',
                    tags: ['widgets'],
                    mode: 'async',
                    execute: async () => 'done'
                })
            },
            presets: false,
            enableAllTools: true
        });
        cancelOff.runtime.manageTool(undefined, { operation: 'disable', name: 'toolCancel' });
        await cancelOff('go');

        const cancelResults = cancelOff.agent.messages
            .filter((entry) => entry.role === 'tool')
            .map((entry) => (entry as { content: string }).content);
        expect(cancelResults).toEqual(['done', SWITCHED_OFF('toolCancel')]);
    });

    it('keeps a withheld name out of every toolRequest field — it is simply not listed', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(4),
            presets: false
        });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-01' });

        // A tag union: the withheld name is absent from `tools`/`enabled`, and `matched`
        // counts only what the catalogue still offers. Not `forbidden`, not `omitted`, not a
        // row with a reason — absent.
        expect(writer.runtime.requestTools(undefined, { tags: ['widgets'] })).toEqual({
            enabled: ['file-00', 'file-02', 'file-03'],
            tools: [matchOf('file-00'), matchOf('file-02'), matchOf('file-03')],
            matched: 3,
            omitted: 0
        });

        // An exact name the user switched off answers like a name that does not exist.
        expect(
            (writer.runtime.requestTools(undefined, { names: ['file-01'] }) as Record<string, unknown>).matched
        ).toBe(0);

        // A regex whose only hit is the withheld name: same answer, and the name never
        // reaches the capped set.
        const regexed = writer.runtime.requestTools(undefined, { regex: '^file-01$' });
        expect((regexed as Record<string, unknown>).enabled).toEqual([]);
        expect(writer.withheldTools).toEqual(['file-01']);

        // A scoped run keeps its own denial channel, and a withheld name does NOT borrow it:
        // `forbidden` stays the scope + deployment-deny field it always was.
        const scoped = writer.runtime.requestTools(
            undefined,
            { names: ['file-01', 'file-02'] },
            undefined,
            ['file-01', 'file-02']
        ) as Record<string, unknown>;
        expect(scoped).toEqual({
            enabled: ['file-02'],
            tools: [matchOf('file-02')],
            matched: 1,
            omitted: 0
        });
    });

    it('moves a tag that only a withheld tool carries out of availableTags and into unmatchedTags', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: {
                ...fixtures(1),
                solo: tool({ name: 'solo', description: 'Solo.', tags: ['sopranos'], execute: () => 'x' })
            },
            presets: false
        });

        // Before the switch: `sopranos` is offered as the retry vocabulary, and a query for
        // it matches.
        const before = writer.runtime.requestTools(undefined, { tags: ['nothing-matching'] }) as Record<
            string,
            unknown
        >;
        expect((before.availableTags as string[])).toContain('sopranos');
        expect((writer.runtime.requestTools(undefined, { tags: ['sopranos'] }) as Record<string, unknown>).matched).toBe(1);

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'solo' });

        // After it: the vocabulary no longer dangles a tool nobody can enable, and the tag
        // itself is honestly reported as unmatched — the two fields that keep a model from
        // searching in circles.
        const after = writer.runtime.requestTools(undefined, { tags: ['nothing-matching'] }) as Record<
            string,
            unknown
        >;
        expect((after.availableTags as string[])).not.toContain('sopranos');

        expect(writer.runtime.requestTools(undefined, { tags: ['sopranos'] })).toEqual({
            enabled: [],
            tools: [],
            matched: 0,
            omitted: 0,
            unmatchedTags: ['sopranos'],
            availableTags: (after.availableTags as string[])
        });
    });

    it('never lets toolRequest resurrect a withheld name, by any selector', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(3),
            presets: false,
            enableAllTools: true
        });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-01' });
        // The switch took `file-01` out of the capped set as well, so the seed order is the
        // runtime rows plus the two names still on.
        expect(writer.discoveredTools).toEqual([
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
            'file-02'
        ]);

        // ONE call, all THREE selectors, and the withheld name is reachable by none of them:
        // the exact name misses, the regex contributes only `file-02`, and the tag union
        // contributes `file-02` and `file-00`.
        expect(
            writer.runtime.requestTools(undefined, {
                names: ['file-01'],
                regex: '^file-0[12]$',
                tags: ['widgets']
            })
        ).toEqual({
            enabled: ['file-02', 'file-00'],
            tools: [matchOf('file-02'), matchOf('file-00')],
            matched: 2,
            omitted: 0
        });

        // Newest-first, exactly like any other selection — and `file-01` stayed switched off
        // through a turn in which three of its selectors fired.
        expect(writer.discoveredTools).toEqual([
            'file-02',
            'file-00',
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
        ]);
        expect(writer.withheldTools).toEqual(['file-01']);
    });

    it('treats cap eviction as capacity, not as a switch, so an evicted name stays discoverable', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(4),
            presets: false,
            maxEnabledTools: 2
        });

        expect(writer.runtime.requestTools(undefined, { names: ['file-00', 'file-01'] })).toEqual({
            enabled: ['file-00', 'file-01'],
            tools: [matchOf('file-00'), matchOf('file-01')],
            matched: 2,
            omitted: 0
        });

        // One more name than the bound: `file-01` is pushed out.
        expect(writer.runtime.requestTools(undefined, { names: ['file-02'] })).toEqual({
            enabled: ['file-02'],
            tools: [matchOf('file-02')],
            matched: 1,
            omitted: 0,
            evicted: ['file-01']
        });

        // THE PIN: eviction wrote the capped set and NOTHING else. The user never decided
        // anything about `file-01`, so it is still listed, still findable, and one query away.
        expect(writer.withheldTools).toEqual([]);
        expect(writer.runtime.requestTools(undefined, { names: ['file-01'] })).toEqual({
            enabled: ['file-01'],
            tools: [matchOf('file-01')],
            matched: 1,
            omitted: 0,
            evicted: ['file-00']
        });
    });

    it('survives the seed pass and a re-registration, and is forgotten only by reset or an explicit enable', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(3),
            presets: false,
            enableAllTools: true
        });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' });
        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'tasks' });
        const capAfterSwitch = writer.discoveredTools;
        expect(capAfterSwitch).not.toContain('file-00');

        // AUTO-ENABLE PATH #1 — the full-toolbox re-seed. It fills the cap with everything
        // the user left on and does not touch a single switch.
        writer.enableAllSwitchableTools();
        expect(writer.discoveredTools).toEqual(capAfterSwitch);
        expect(writer.withheldTools).toEqual(['file-00', 'tasks']);

        // AUTO-ENABLE PATH #2 — a re-registration of the same name (an update, a folder
        // re-scan, a plugin publishing its row again). Editing a tool's source is not the
        // user taking it back, and the immediate-enable a creation normally performs must
        // not fire for it.
        await writer.createTool({
            name: 'file-00',
            description: 'file-00 replaced.',
            tags: ['widgets'],
            source: 'return 1;'
        });

        expect(writer.withheldTools).toEqual(['file-00', 'tasks']);
        expect(writer.discoveredTools).toEqual(capAfterSwitch);
        expect(
            (writer.runtime.manageTool(undefined, { operation: 'details', name: 'file-00' }) as Record<
                string,
                unknown
            >).enabled
        ).toBe(false);

        // A NEW conversation: a reset starts with everything on, which is also what makes the
        // reset + re-seed pair equal a freshly created session.
        writer.reset();
        expect(writer.withheldTools).toEqual([]);
        expect(writer.discoveredTools).toEqual([]);

        writer.enableAllSwitchableTools();
        expect(writer.withheldTools).toEqual([]);
        expect(writer.discoveredTools).toEqual([
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
            'file-01',
            'file-02'
        ]);
    });

    it('un-registers the switch with the name, so a later create is not shadowed by an old decision', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true
        });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' });
        expect(writer.withheldTools).toEqual(['file-00']);

        expect(
            (writer.runtime.manageTool(undefined, { operation: 'remove', name: 'file-00' }) as Record<
                string,
                unknown
            >).removed
        ).toBe(true);

        // The registry, the capped set, and the SWITCH all moved together: the snapshot the
        // observer is about to write names the removed tool nowhere.
        expect(writer.withheldTools).toEqual([]);
        expect(writer.snapshot().discovery).toEqual({
            enabled: [
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
            ],
            offsets: []
        });
    });

    it('answers the handle as a sorted, detached view — a caller cannot switch a tool through it', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(2),
            presets: false
        });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' });
        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'toolRequest' });

        const view = writer.withheldTools as string[];
        view.push('zzz');
        view.reverse();

        expect(writer.withheldTools).toEqual(['file-00', 'toolRequest']);
        expect(writer.withheldTools).toEqual(writer.withheldTools);
    });

    it('stops telling a model to call a toolRequest this conversation has switched off', async () => {
        const on = harness({
            agents: { writer: brain(scripted([callTool('c1', 'nope', '{}'), answer('recovered')])) },
            tools: fixtures(1),
            presets: false
        });
        await on('go');
        expect((on.agent.messages[2] as { content: string }).content).toBe(
            'Tool "nope" is not registered. Available tools: toolRequest, tasks. Call toolRequest with capability tags to search the catalogue.'
        );

        const off = harness({
            agents: { writer: brain(scripted([callTool('c1', 'nope', '{}'), answer('recovered')])) },
            tools: fixtures(1),
            presets: false
        });
        off.runtime.manageTool(undefined, { operation: 'disable', name: 'toolRequest' });
        await off('go');

        // Same answer, minus the instruction that would send the model after an undeclared
        // tool. The declared-tool list in the sentence is already filtered, so `toolRequest`
        // is gone from both halves at once.
        expect((off.agent.messages[2] as { content: string }).content).toBe(
            'Tool "nope" is not registered. Available tools: tasks.'
        );
    });

    it('keeps the manual and nested doors open, which is what the REST and tool-to-tool guarantees mean', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: {
                ...fixtures(1),
                ping: tool({
                    name: 'ping',
                    description: 'Ping.',
                    tags: ['ping'],
                    visibility: 'core',
                    execute: () => 'pong'
                })
            },
            presets: false
        });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'ping' });

        // The operator's door (what `POST /tools/:name` calls).
        expect(await writer.executeTool('ping', {})).toBe('pong');
        // The programmatic door (what `context.callTool` reaches from a running tool).
        expect(await writer.callTool('ping', {})).toBe('pong');
        expect(writer.withheldTools).toEqual(['ping']);

        // A withheld searchable name is still callable by a host too: the switch is a
        // declaration rule, not an execution rule.
        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' });
        expect(await writer.executeTool('file-00', {})).toBe('file-00');
    });

    it('projects the switch on the details view, which is the row a tool pane renders', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(1),
            presets: false,
            enableAllTools: true
        });

        const details = (name: string): Record<string, unknown> =>
            writer.runtime.manageTool(undefined, { operation: 'details', name }) as Record<string, unknown>;

        // Before: a core name reads enabled (it is in context) and the seeded searchable one
        // reads enabled (it holds a slot).
        expect(details('toolRequest')).toMatchObject({ visibility: 'core', enabled: true });
        expect(details('file-00')).toMatchObject({ visibility: 'searchable', enabled: true });

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'toolRequest' });
        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'file-00' });

        // After: both read off, by the SAME field — and the registration and the source
        // record are untouched, which is what tells a pane "off", not "gone".
        expect(details('toolRequest')).toMatchObject({ visibility: 'core', enabled: false, hasSource: true });
        expect(details('file-00')).toMatchObject({ visibility: 'searchable', enabled: false, hasSource: false });

        // An evicted-but-not-switched name reads off as well, and the two states are
        // distinguished by `harness.withheldTools`, which is why that seam exists.
        const capped = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: fixtures(3),
            presets: false,
            maxEnabledTools: 1
        });
        capped.runtime.requestTools(undefined, { names: ['file-00'] });
        capped.runtime.requestTools(undefined, { names: ['file-01'] });
        // The EVICTED name reads off on this field exactly like a switched-off one — the
        // eviction itself is invisible here (`file-01` took the only slot). `withheldTools`
        // is the seam that separates the two states, which is why it exists.
        expect(
            (capped.runtime.manageTool(undefined, { operation: 'details', name: 'file-01' }) as Record<
                string,
                unknown
            >).enabled
        ).toBe(true);
        expect(
            (capped.runtime.manageTool(undefined, { operation: 'details', name: 'file-00' }) as Record<
                string,
                unknown
            >).enabled
        ).toBe(false);
        expect(capped.withheldTools).toEqual([]);
    });

    it('applies to every actor of the session at once — a delegated child and a thread see the same switch', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: {
                writer: brain(
                    scripted(
                        [callTool('c1', 'delegate', '{"agent":"researcher","input":"check"}'), answer('done')],
                        seen
                    )
                ),
                // The child's requests land in the SAME `seen` list, which is the point: the
                // switch has to be visible from both sides of the delegation.
                researcher: brain(scripted([answer('checked')], seen))
            },
            subagents: ['researcher'],
            tools: {
                ...fixtures(1),
                ping: tool({
                    name: 'ping',
                    description: 'Ping.',
                    tags: ['ping'],
                    visibility: 'core',
                    execute: () => 'pong'
                })
            },
            presets: false
        });

        await writer('go');

        // Request 1 is the primary, 2 is the DELEGATED child (no `delegate`: a subagent
        // cannot delegate further), 3 is the primary's follow-up. `ping` is declared to all
        // three — one session-level rule, not a per-actor list.
        expect(seen.map((request) => (request.tools ?? []).map((entry) => entry.name))).toEqual([
            ['toolRequest', 'tasks', 'delegate', 'ping'],
            ['toolRequest', 'tasks', 'ping'],
            ['toolRequest', 'tasks', 'delegate', 'ping']
        ]);

        writer.runtime.manageTool(undefined, { operation: 'disable', name: 'ping' });

        // A turn asked of the CHILD's own conversation, after the switch. The user of the
        // session switched one name off; every thread of that session loses it, which is what
        // "tool control via the tool panel is global session level, affecting all threads"
        // means at the kernel.
        expect((await writer.sendThreadInput('agent:researcher', 'again')).content).toBe('checked');
        expect(seen[3].tools?.map((entry) => entry.name)).toEqual(['toolRequest', 'tasks']);
        expect(writer.withheldTools).toEqual(['ping']);

        // The switch is conversation state, so a NEW conversation of the same harness starts
        // without it (and the child's history is untouched by that decision).
        writer.reset();
        expect(writer.withheldTools).toEqual([]);
    });
});

