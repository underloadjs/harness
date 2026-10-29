// R3a — versioned snapshot/restore of the harness's core state.
//
// The contract pinned here:
//   - snapshot() is complete, JSON-shaped data for agent transcripts/models,
//     discovery (enabled set + progressive offsets), runtime-created tool sources,
//     the lifetime creation budget, and all four session record stores;
//   - snapshot() never carries provider credentials or function values, and
//     excludes in-flight execution state;
//   - snapshot() is a safe READ while a run is active: a completed tool's store
//     mutation and tool-result message can be persisted before the turn settles
//     (T16), while restore stays forbidden until the run ends;
//   - restore() validates schema/version and every record, compiles created-tool
//     source WITHOUT executing it, and leaves the target untouched on failure;
//   - a restored harness behaves like the source harness: next ids continue,
//     discovered tools stay declared, created tools are callable, and the next
//     request sends the restored transcript;
//   - restore() is idempotent for a harness that already restored the same file.
//
// Deterministic values below come from the public tool contracts (todo/profile/
// chapter/location) and the discovery ranking (name order for equal scores), not
// from reading implementation output after the fact.

import { describe, expect, it } from 'vitest';
import {
    HARNESS_SNAPSHOT_VERSION,
    agent,
    harness,
    tool
} from '@underload/harness';
import type {
    Harness,
    HarnessSnapshot,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    ToolCreation
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// One scripted turn list replayed request-by-request. `seen` records the exact
// request the harness built, which is how the resume test proves it replayed the
// restored transcript and declarations.
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

// 11 searchable tools with one shared tag. One toolRequest call therefore returns
// the capped page 1 (5) and leaves a progressive-discovery offset of 5.
const bulkName = (index: number): string => `bulk${String(index).padStart(2, '0')}`;

const bulkTools = (): Record<string, ReturnType<typeof tool>> =>
    Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => {
            const name = bulkName(index + 1);
            return [
                name,
                tool({
                    description: `Bulk tool ${name}.`,
                    tags: ['bulk'],
                    execute: () => name
                })
            ];
        })
    );

type SessionOptions = {
    seen?: HarnessStreamRequest[];
    turns?: HarnessStreamEvent[][];
    stateChange?: (event: HarnessStateChangeEvent) => void;
    maxCreatedTools?: number;
};

// Two agents with seeded transcripts and distinct models, plus the bulk catalogue.
// Everything the snapshot should preserve is present before the first operation.
const buildSession = (options: SessionOptions = {}): Harness => {
    const writer = agent({
        model: 'merge/ds4-flash',
        instruction: 'Write.',
        messages: [
            { role: 'user', content: 'seed question' },
            { role: 'assistant', content: 'seed answer' }
        ],
        stream: scripted(options.turns ?? [answer('fresh')], options.seen)
    });

    const researcher = agent({
        model: 'research/model',
        instruction: 'Research.',
        messages: [{ role: 'user', content: 'seed research' }],
        stream: scripted([answer('fresh research')])
    });

    return harness({
        agents: { writer, researcher },
        primary: 'writer',
        subagents: ['researcher'],
        tools: bulkTools(),
        presets: false,
        maxCreatedTools: options.maxCreatedTools,
        report: options.stateChange ? { stateChange: options.stateChange } : undefined
    });
};

// The runtime-created tool used throughout. One optional-free property keeps the
// single-property rule easy to exercise through the manual path.
const repeatCreation: ToolCreation = {
    name: 'repeat',
    description: 'Repeat text.',
    tags: ['text', 'repeat'],
    parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
    },
    source: 'return args;'
};

// A thorough JSON clone: mutations in a test never touch the previous fixture.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const seededWriterMessages = [
    { role: 'system', content: 'Write.' },
    { role: 'user', content: 'seed question' },
    { role: 'assistant', content: 'seed answer' }
];

const seededResearcherMessages = [
    { role: 'system', content: 'Research.' },
    { role: 'user', content: 'seed research' }
];

// The expected snapshot after the fixture operations in the round-trip test.
const buildExpectedSnapshot = (): HarnessSnapshot => ({
    version: HARNESS_SNAPSHOT_VERSION,
    agents: {
        writer: { model: 'merge/ds4-flash', messages: seededWriterMessages },
        researcher: { model: 'research/model', messages: seededResearcherMessages }
    },
    discovery: {
        enabled: ['bulk01', 'bulk02', 'bulk03', 'bulk04', 'bulk05', 'repeat'],
        // discoveryQueryKey(['bulk'], undefined) === JSON.stringify([['bulk'], null])
        offsets: [{ query: '[["bulk"],null]', offset: 5 }]
    },
    createdTools: [repeatCreation],
    createdToolCount: 1,
    records: {
        todos: {
            items: [
                { id: '1', text: 'Plan', completed: false },
                { id: '2', text: 'Draft', completed: true }
            ],
            nextId: 3
        },
        profiles: {
            items: [
                {
                    id: '1',
                    name: 'Elena',
                    description: 'A cartographer.',
                    traits: ['cartographer', 'pilot'],
                    notes: 'Travels.'
                }
            ],
            nextId: 2
        },
        chapters: {
            items: [
                {
                    id: '1',
                    title: 'Arrival',
                    summary: 'They arrive.',
                    content: 'Body.',
                    status: 'draft',
                    order: 2
                },
                {
                    id: '2',
                    title: 'Return',
                    summary: 'They return.',
                    content: '',
                    status: 'planned'
                }
            ],
            nextId: 3
        },
        locations: {
            items: [
                {
                    id: '1',
                    name: 'Harbor',
                    description: 'A port.',
                    notes: 'Fog.'
                }
            ],
            nextId: 2
        }
    }
});

// Populate the source harness through the public manual path, in an order that
// leaves one untouched discovery offset.
const seedSource = async (): Promise<Harness> => {
    const writer = buildSession();

    await writer.executeTool('toolRequest', { tags: ['bulk'] });
    await writer.executeTool('toolCreate', repeatCreation);

    await writer.executeTool('todoManage', { action: 'add', text: 'Plan' });
    await writer.executeTool('todoManage', { action: 'add', text: 'Draft' });
    await writer.executeTool('todoManage', { action: 'check', id: '2' });

    await writer.executeTool('profileManage', {
        action: 'add',
        name: 'Elena',
        description: 'A cartographer.',
        traits: ['cartographer', 'pilot'],
        notes: 'Travels.'
    });

    await writer.executeTool('chapterManage', {
        action: 'add',
        title: 'Arrival',
        summary: 'They arrive.',
        content: 'Body.',
        status: 'draft',
        order: 2
    });
    await writer.executeTool('chapterManage', {
        action: 'add',
        title: 'Return',
        summary: 'They return.'
    });

    await writer.executeTool('locationManage', {
        action: 'add',
        name: 'Harbor',
        description: 'A port.',
        notes: 'Fog.'
    });

    return writer;
};

// A snapshot with one record store and one created tool, for the invalid-input
// matrix. Kept small so each mutation is obvious.
const seedSmall = async (): Promise<HarnessSnapshot> => {
    const writer = buildSession();
    await writer.executeTool('todoManage', { action: 'add', text: 'One' });
    await writer.executeTool('toolCreate', repeatCreation);
    return writer.snapshot();
};

const expectJsonShaped = (value: unknown): void => {
    if (value === null) return;

    const type = typeof value;

    if (type === 'function') throw new Error('snapshot contains a function');
    if (type === 'undefined') throw new Error('snapshot contains undefined');
    if (type === 'bigint' || type === 'symbol') throw new Error(`snapshot contains a ${type}`);

    if (type === 'number') {
        if (!Number.isFinite(value)) throw new Error('snapshot contains a non-finite number');
        return;
    }

    if (type !== 'object') return;

    if (Array.isArray(value)) {
        for (const entry of value) expectJsonShaped(entry);
        return;
    }

    for (const entry of Object.values(value as Record<string, unknown>)) expectJsonShaped(entry);
};

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('harness snapshot/restore', () => {
    it('round-trips every core category through JSON and resumes ordinary behaviour', async () => {
        const source = await seedSource();
        const snapshot = source.snapshot();

        // The whole value, not a sample: every persisted category is pinned.
        expect(snapshot).toEqual(buildExpectedSnapshot());

        // It must survive the disk shape a server writes.
        expectJsonShaped(snapshot);
        const json = JSON.parse(JSON.stringify(snapshot));
        expect(json).toEqual(snapshot);

        const target = buildSession();
        target.restore(json);

        expect(target.snapshot()).toEqual(snapshot);
        expect(target.discoveredTools).toEqual([
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'repeat'
        ]);
        expect(target.agents.writer.model()).toBe('merge/ds4-flash');
        expect(target.agents.researcher.model()).toBe('research/model');
        expect(target.agents.writer.messages).toEqual(seededWriterMessages);
        expect(target.agents.researcher.messages).toEqual(seededResearcherMessages);

        // Ids continue from the restored counters.
        expect(await target.executeTool('todoManage', { action: 'add', text: 'Next' })).toEqual({
            todo: { id: '3', text: 'Next', completed: false },
            counts: { total: 3, completed: 1, remaining: 2 }
        });

        // Record bodies and trait arrays survived the copy.
        expect(await target.executeTool('profileManage', { action: 'get', id: '1' })).toEqual({
            profile: {
                id: '1',
                name: 'Elena',
                description: 'A cartographer.',
                traits: ['cartographer', 'pilot'],
                notes: 'Travels.'
            },
            counts: { total: 1 }
        });
        expect(await target.executeTool('chapterManage', { action: 'get', id: '1' })).toEqual({
            chapter: {
                id: '1',
                title: 'Arrival',
                summary: 'They arrive.',
                status: 'draft',
                order: 2
            },
            content: 'Body.',
            counts: { total: 2, planned: 1, draft: 1, complete: 0 }
        });
        expect(await target.executeTool('locationManage', { action: 'list' })).toEqual({
            locations: [
                { id: '1', name: 'Harbor', description: 'A port.', notes: 'Fog.' }
            ],
            counts: { total: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });

        // The recompiled created tool is callable (compilation happened at restore;
        // execution happens only because this test asks for it).
        expect(await target.executeTool('repeat', 'ab')).toBe('ab');

        // The persisted progressive-discovery offset continues the NEXT tranche of
        // the identical query instead of restarting at page 1.
        expect(await target.executeTool('toolRequest', { tags: ['bulk'] })).toEqual({
            enabled: ['bulk06', 'bulk07', 'bulk08', 'bulk09', 'bulk10'],
            tools: [
                { name: 'bulk06', description: 'Bulk tool bulk06.', tags: ['bulk'] },
                { name: 'bulk07', description: 'Bulk tool bulk07.', tags: ['bulk'] },
                { name: 'bulk08', description: 'Bulk tool bulk08.', tags: ['bulk'] },
                { name: 'bulk09', description: 'Bulk tool bulk09.', tags: ['bulk'] },
                { name: 'bulk10', description: 'Bulk tool bulk10.', tags: ['bulk'] }
            ],
            remaining: 1,
            offset: 5,
            truncated: true
        });
        expect(target.discoveredTools).toEqual([
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'repeat',
            'bulk06',
            'bulk07',
            'bulk08',
            'bulk09',
            'bulk10'
        ]);
    });

    it('sends the restored transcript and discovered declarations on the next request', async () => {
        const source = await seedSource();
        const json = JSON.parse(JSON.stringify(source.snapshot()));
        const seen: HarnessStreamRequest[] = [];

        const resumed = buildSession({ seen, turns: [answer('continued')] });
        resumed.restore(json);

        const message = await resumed('continue');

        expect(message.content).toBe('continued');
        expect(seen).toHaveLength(1);
        expect(seen[0].messages).toEqual([
            ...seededWriterMessages,
            { role: 'user', content: 'continue' }
        ]);
        expect((seen[0].tools ?? []).map((declaration) => declaration.name)).toEqual([
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentDelegate',
            'threadFork',
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'repeat'
        ]);
    });

    it('restore is idempotent: applying the same snapshot twice replaces, not duplicates', async () => {
        const source = await seedSource();
        const snapshot = source.snapshot();
        const target = buildSession();

        target.restore(snapshot);
        target.restore(snapshot);

        expect(target.snapshot()).toEqual(snapshot);
        expect(Object.keys(target.tools).filter((name) => name === 'repeat')).toEqual(['repeat']);
    });

    it('compiles a created tool on restore without executing its body', async () => {
        const source = buildSession();
        const dangerous: ToolCreation = {
            ...repeatCreation,
            name: 'danger',
            description: 'Must not run during restore.',
            source: 'throw new Error("snapshot restore executed the tool body");'
        };

        await source.executeTool('toolCreate', dangerous);
        const snapshot = source.snapshot();
        const target = buildSession();

        expect(() => target.restore(snapshot)).not.toThrow();
        expect(target.tools.danger).toBeDefined();

        // The body is only reachable through an actual call.
        await expect(target.executeTool('danger', {})).rejects.toThrow(
            'snapshot restore executed the tool body'
        );
    });

    it('omits provider credentials, headers, and functions', async () => {
        const secret = 'sk-snapshot-secret';
        const writer = agent({
            model: 'merge/ds4-flash',
            instruction: 'Write.',
            stream: scripted([answer('unused')]),
            provider: {
                baseURL: 'http://private-provider.example/v1',
                apiKey: () => secret,
                headers: { Authorization: `Bearer ${secret}` }
            }
        });

        const session = harness({ agents: { writer }, presets: false });
        const snapshot = session.snapshot();
        const serialized = JSON.stringify(snapshot);

        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('private-provider.example');
        expect(serialized).not.toContain('Authorization');
        expectJsonShaped(snapshot);
        expect(JSON.parse(serialized)).toEqual(snapshot);
    });

    it('allows snapshot while a run is active, but still refuses restore', async () => {
        let startedResolve: () => void = () => {};
        const started = new Promise<void>((resolve) => {
            startedResolve = resolve;
        });
        let releaseResolve: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            releaseResolve = resolve;
        });

        const writer = agent({
            model: 'merge/ds4-flash',
            stream: async function* () {
                startedResolve();
                await gate;
                yield { type: 'text', delta: 'ok' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
            }
        });

        const session = harness({ agents: { writer }, presets: false });
        const before = session.snapshot();
        const running = session('go');

        await started;

        // The user message is committed; the assistant reply is still streaming.
        // Snapshot reads the committed state and never mutates anything.
        expect(session.snapshot()).toEqual({
            version: HARNESS_SNAPSHOT_VERSION,
            agents: {
                writer: {
                    model: 'merge/ds4-flash',
                    messages: [{ role: 'user', content: 'go' }]
                }
            },
            discovery: { enabled: [], offsets: [] },
            createdTools: [],
            createdToolCount: 0,
            records: {
                todos: { items: [], nextId: 1 },
                profiles: { items: [], nextId: 1 },
                chapters: { items: [], nextId: 1 },
                locations: { items: [], nextId: 1 }
            }
        });

        // Restore would replace the transcript the loop is using, so it stays
        // forbidden until the run settles.
        expect(() => session.restore(before)).toThrow(
            'Cannot restore while an agent run is in progress; wait for the run to settle.'
        );

        releaseResolve();
        await running;
    });

    it('captures a completed tool mutation when paused before the next model turn', async () => {
        let secondStartedResolve: () => void = () => {};
        const secondStarted = new Promise<void>((resolve) => {
            secondStartedResolve = resolve;
        });
        let releaseResolve: () => void = () => {};
        const release = new Promise<void>((resolve) => {
            releaseResolve = resolve;
        });

        const toolArguments = '{"action":"add","text":"Durable"}';
        let calls = 0;

        const stream: HarnessStream = async function* () {
            calls++;

            if (calls === 1) {
                yield {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'c1', name: 'todoManage', arguments: toolArguments }]
                };
                return;
            }

            // The tool has completed and its result is committed; pause before the
            // next model request produces anything.
            secondStartedResolve();
            await release;

            yield { type: 'text', delta: 'done' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const captures: HarnessSnapshot[] = [];
        const session = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream }) },
            presets: false,
            report: {
                stateChange: (event) => {
                    // Reading during the active run must succeed (T16 regression):
                    // the completed tool's store state and its tool message are
                    // already committed at this synchronous boundary.
                    if (event.reason === 'tool_execute') captures.push(session.snapshot());
                }
            }
        });

        const running = session('go');

        await secondStarted;

        expect(captures).toHaveLength(1);
        const checkpoint = captures[0];

        expect(checkpoint.records.todos).toEqual({
            items: [{ id: '1', text: 'Durable', completed: false }],
            nextId: 2
        });
        expect(checkpoint.agents.writer.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'todoManage', arguments: toolArguments }]
            },
            {
                role: 'tool',
                content:
                    '{"todo":{"id":"1","text":"Durable","completed":false},"counts":{"total":1,"completed":0,"remaining":1}}',
                toolCallId: 'c1',
                name: 'todoManage'
            }
        ]);

        // A direct read at the pause returns the same coherent checkpoint.
        expect(session.snapshot()).toEqual(checkpoint);

        releaseResolve();
        await running;

        // Restart from the interrupted-turn checkpoint. Restore must not replay
        // todoManage: the store already contains exactly one item.
        const target = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream: scripted([answer('unused')]) }) },
            presets: false
        });
        target.restore(checkpoint);

        expect(target.snapshot()).toEqual(checkpoint);
        expect(await target.executeTool('todoManage', { action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Durable', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
    });
});

// ---------------------------------------------------------------------------
// Validation / no partial application
// ---------------------------------------------------------------------------

describe('harness restore validation', () => {
    // Every invalid case starts from a fresh target and asserts both the exact
    // error and that the target is byte-for-byte unchanged.
    const restoreRejects = async (
        mutate: (snapshot: HarnessSnapshot) => unknown,
        expected: RegExp
    ): Promise<void> => {
        const valid = await seedSmall();
        const target = buildSession();
        const before = target.snapshot();
        const invalid = clone(valid) as unknown as HarnessSnapshot;

        mutate(invalid);

        expect(() => target.restore(invalid)).toThrow(expected);
        expect(target.snapshot()).toEqual(before);
    };

    it('pins the schema version', async () => {
        await restoreRejects((snapshot) => {
            snapshot.version = 2 as unknown as HarnessSnapshot['version'];
        }, /Snapshot version 2 is not supported; this harness reads version 1\./);
    });

    it('rejects a non-object snapshot and unknown top-level fields', async () => {
        const valid = await seedSmall();
        const target = buildSession();

        expect(() => target.restore(null as unknown as HarnessSnapshot)).toThrow(
            'snapshot must be a JSON object.'
        );

        await restoreRejects((snapshot) => {
            (snapshot as unknown as Record<string, unknown>).config = { apiKey: 'leak' };
        }, /snapshot has an unknown field "config"\./);
    });

    it('rejects a malformed agent message', async () => {
        await restoreRejects((snapshot) => {
            (snapshot.agents.writer.messages[0] as unknown as Record<string, unknown>).content = 7;
        }, /snapshot\.agents\["writer"\]\.messages\[0\]\.content must be a string\./);
    });

    it('rejects unknown and missing agents', async () => {
        await restoreRejects((snapshot) => {
            snapshot.agents.intruder = clone(snapshot.agents.writer);
        }, /Snapshot agent "intruder" is not registered in this harness\./);

        await restoreRejects((snapshot) => {
            delete snapshot.agents.researcher;
        }, /Agent "researcher" is missing from the snapshot; it cannot be resumed from this file\./);
    });

    it('rejects discovery naming a tool this harness does not register', async () => {
        await restoreRejects((snapshot) => {
            snapshot.discovery.enabled = ['ghost'];
        }, /Snapshot discovery names "ghost", which is not registered in this harness\./);
    });

    it('rejects a created-tool count that disagrees with the records', async () => {
        await restoreRejects((snapshot) => {
            snapshot.createdToolCount = 0;
        }, /snapshot\.createdToolCount is 0, but snapshot\.createdTools has 1 records\./);
    });

    it('rejects created-tool source that no longer compiles', async () => {
        await restoreRejects((snapshot) => {
            snapshot.createdTools[0].source = 'return (';
        }, /Tool source could not be compiled:/);
    });

    it('rejects a created tool colliding with a configured/preset tool', async () => {
        await restoreRejects((snapshot) => {
            snapshot.createdTools[0].name = 'bulk01';
        }, /Tool "bulk01" is already registered in this harness; the snapshot cannot be restored\./);
    });

    it('rejects a created tool count above the target creation budget', async () => {
        const valid = await seedSmall();
        const target = buildSession({ maxCreatedTools: 1 });
        const extra = { ...clone(repeatCreation), name: 'second' };

        // The same two-record snapshot is valid on a harness with room for two, so
        // only the target's budget can be what fails.
        const source = buildSession({ maxCreatedTools: 2 });
        await source.executeTool('toolCreate', repeatCreation);
        await source.executeTool('toolCreate', extra);
        const twoTools = source.snapshot();
        const before = target.snapshot();

        expect(() => target.restore(twoTools)).toThrow(
            'Snapshot records 2 created tools; this harness allows at most 1.'
        );
        expect(target.snapshot()).toEqual(before);
    });

    it('rejects non-JSON values inside a created tool schema', async () => {
        await restoreRejects((snapshot) => {
            (snapshot.createdTools[0].parameters as Record<string, unknown>).fn = () => 1;
        }, /snapshot\.createdTools\[0\]\.parameters\.fn contains a non-JSON function\./);
    });

    it('rejects duplicate record ids and a colliding nextId', async () => {
        await restoreRejects((snapshot) => {
            snapshot.records.todos.items.push(clone(snapshot.records.todos.items[0]));
            snapshot.records.todos.nextId = 3;
        }, /todo state contains the duplicate id "1"\./);

        await restoreRejects((snapshot) => {
            snapshot.records.todos.nextId = 1;
        }, /todo state\.nextId must be greater than the largest id \(1\); received 1\./);
    });

    it('rejects unknown record fields', async () => {
        await restoreRejects((snapshot) => {
            (snapshot.records.locations as unknown as Record<string, unknown>).extra = true;
        }, /location state has an unknown field "extra"\./);
    });
});

// ---------------------------------------------------------------------------
// Persistence observer (T3 addendum)
// ---------------------------------------------------------------------------

describe('state-change observer', () => {
    it('fires after every snapshot-managed mutation the harness performs', async () => {
        const events: HarnessStateChangeEvent[] = [];
        let writer!: Harness;

        writer = buildSession({
            stateChange: (event) => events.push(event),
            turns: [
                callTool('c1', 'todoManage', '{"action":"add","text":"Persist me"}'),
                answer('done')
            ]
        });

        await writer('go');

        // user append, tool-call assistant append, tool-result append, the tool
        // execution, then the final assistant append.
        expect(events).toEqual([
            { type: 'state_change', reason: 'agent_message', agent: 'writer' },
            { type: 'state_change', reason: 'agent_message', agent: 'writer' },
            { type: 'state_change', reason: 'agent_message', agent: 'writer' },
            { type: 'state_change', reason: 'tool_execute', agent: 'writer', tool: 'todoManage' },
            { type: 'state_change', reason: 'agent_message', agent: 'writer' }
        ]);

        events.length = 0;

        // Manual Tools-tab mutations emit no progress events, so this is the only
        // observation point.
        await writer.executeTool('profileManage', {
            action: 'add',
            name: 'Elena',
            description: 'A cartographer.'
        });
        expect(events).toEqual([
            { type: 'state_change', reason: 'tool_execute', tool: 'profileManage' }
        ]);

        events.length = 0;
        await writer.executeTool('toolCreate', repeatCreation);
        expect(events).toEqual([
            { type: 'state_change', reason: 'tool_create', tool: 'repeat' },
            { type: 'state_change', reason: 'tool_execute', tool: 'toolCreate' }
        ]);

        events.length = 0;
        writer.reset();
        expect(events).toEqual([{ type: 'state_change', reason: 'reset' }]);

        events.length = 0;
        const snapshot = writer.snapshot();
        writer.restore(snapshot);
        expect(events).toEqual([{ type: 'state_change', reason: 'restore' }]);
    });

    it('ignores observer failures so persistence cannot change harness behaviour', async () => {
        const writer = buildSession({
            stateChange: () => {
                throw new Error('disk full');
            }
        });

        await writer.executeTool('todoManage', { action: 'add', text: 'Still here' });

        expect(await writer.executeTool('todoManage', { action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Still here', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
    });
});
