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
        expect(result.matched).toBe(5);
        expect(result.omitted).toBe(3);
        expect(result.alreadyAvailable.map((match: { name: string }) => match.name)).toEqual([
            'toolCreate',
            'toolList',
            'toolManage',
            'toolRegistry',
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

        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: [],
            tools: [],
            matched: 0,
            omitted: 0,
            availableTags: ['widgets']
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
