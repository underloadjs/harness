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
//   - restore() is idempotent for a harness that already restored the same file;
//   - the task store's T1 half survives a round trip: per-record `rev` and
//     attribution, the holder pair + `leaseUntil`, and the bounded change feed
//     (`storeRev` + `changes`). A pre-T1 file has NONE of those keys and still
//     restores with the documented defaults (`rev: 1`, `storeRev: 0`,
//     `changes: []`), while a persisted field the schema does not describe is
//     reported instead of dropped - see the last two describe blocks.
//
// Deterministic values below come from the public tool contracts (todo/profile/
// chapter/location) and the discovery ranking (name order for equal scores), not
// from reading implementation output after the fact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HARNESS_SNAPSHOT_VERSION,
    agent,
    harness,
    tool
} from '@underload/harness';
import { TASK_DEFAULT_LEASE_MS } from './core/task';
import type {
    Agent,
    Harness,
    HarnessSnapshot,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    TaskChange,
    TaskChangeOp,
    TaskItem,
    TaskResult,
    ToolCreation
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Clock policy
// ---------------------------------------------------------------------------
// THE FROZEN CLOCK. The task store stamps every write with Date (src/core/task.ts
// `updatedAt`, the change-feed `at`, and a claim's `leaseUntil = now + leaseMs`),
// and those values are part of `records.todos` from T1 on — so a whole-snapshot
// `toEqual` needs ONE exact instant. `toFake: ['Date']` leaves setTimeout and the
// microtask queue real, which the gated transports in this file depend on (the
// same policy src/harness.thread-runtime.test.ts uses).
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);
const LEASE_UNTIL = EPOCH_MS + TASK_DEFAULT_LEASE_MS;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EPOCH_MS);
});

afterEach(() => {
    vi.useRealTimers();
});

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

// 11 searchable tools with one shared tag. Selection is uncapped, so one
// toolRequest call enables all eleven and records no legacy paging offset.
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

// One stored task record as `records.todos` persists it (src/core/task.ts
// `copyItem`). Every write in this file goes through `executeTool`, which hands the
// tool the PRIMARY agent and NO thread, so `updatedBy` is set and `updatedThreadId`
// is absent entirely. `rev` is the content revision: 1 on add, +1 only for a real
// text/completed change, and never for a claim.
const taskItem = (
    id: string,
    text: string,
    shape: {
        completed?: boolean;
        rev?: number;
        by?: string;
        threadId?: string;
        at?: string;
        owner?: string;
        ownerThreadId?: string;
        leaseUntil?: number;
    } = {}
): TaskItem => ({
    id,
    text,
    completed: shape.completed ?? false,
    rev: shape.rev ?? 1,
    ...(shape.by === undefined ? {} : { updatedBy: shape.by }),
    ...(shape.threadId === undefined ? {} : { updatedThreadId: shape.threadId }),
    ...(shape.at === undefined ? {} : { updatedAt: shape.at }),
    ...(shape.owner === undefined ? {} : { owner: shape.owner }),
    ...(shape.ownerThreadId === undefined ? {} : { ownerThreadId: shape.ownerThreadId }),
    ...(shape.leaseUntil === undefined ? {} : { leaseUntil: shape.leaseUntil })
});

// One change-log entry in the canonical key order core/task.ts appends them in.
const taskEvent = (
    rev: number,
    id: string,
    op: TaskChangeOp,
    shape: {
        by?: string;
        threadId?: string;
        at?: string;
        fields?: Array<'text' | 'completed'>;
        itemRev?: number;
    } = {}
): TaskChange => ({
    rev,
    id,
    op,
    ...(shape.by === undefined ? {} : { by: shape.by }),
    ...(shape.threadId === undefined ? {} : { threadId: shape.threadId }),
    at: shape.at ?? EPOCH_ISO,
    ...(shape.fields === undefined ? {} : { fields: shape.fields }),
    ...(shape.itemRev === undefined ? {} : { itemRev: shape.itemRev })
});

// The expected snapshot after the fixture operations in the round-trip test.
const buildExpectedSnapshot = (): HarnessSnapshot => ({
    version: HARNESS_SNAPSHOT_VERSION,
    agents: {
        writer: { model: 'merge/ds4-flash', messages: seededWriterMessages },
        researcher: { model: 'research/model', messages: seededResearcherMessages }
    },
    discovery: {
        enabled: [
            // toolCreate is the newest mutation, so it leads the current order.
            'repeat',
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'bulk06',
            'bulk07',
            'bulk08',
            'bulk09',
            'bulk10',
            'bulk11'
        ],
        // selectTools is uncapped, so the legacy progressive-discovery offset map
        // stays empty.
        offsets: []
    },
    createdTools: [repeatCreation],
    createdToolCount: 1,
    records: {
        // T1 persistence: every record carries its content revision and the writer,
        // and the store keeps `storeRev` plus the bounded change feed so a resumed
        // session can answer `since` without replaying anything.
        todos: {
            items: [
                taskItem('1', 'Plan', { by: 'writer', at: EPOCH_ISO }),
                taskItem('2', 'Draft', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO })
            ],
            nextId: 3,
            storeRev: 3,
            changes: [
                taskEvent(1, '1', 'add', { by: 'writer', itemRev: 1 }),
                taskEvent(2, '2', 'add', { by: 'writer', itemRev: 1 }),
                taskEvent(3, '2', 'update', { by: 'writer', fields: ['completed'], itemRev: 2 })
            ]
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

    await writer.executeTool('task', { tasks: [{ text: 'Plan' }] });
    await writer.executeTool('task', { tasks: [{ text: 'Draft' }] });
    // A guarded write (executeTool runs as the primary agent) needs the token the
    // caller read: id "2" was added at content rev 1 (src/core/task.ts).
    await writer.executeTool('task', {
        tasks: [{ id: '2', completed: true }],
        expects: [{ id: '2', rev: 1 }]
    });

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
    await writer.executeTool('task', { tasks: [{ text: 'One' }] });
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
            'repeat',
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'bulk06',
            'bulk07',
            'bulk08',
            'bulk09',
            'bulk10',
            'bulk11'
        ]);
        expect(target.agents.writer.model()).toBe('merge/ds4-flash');
        expect(target.agents.researcher.model()).toBe('research/model');
        expect(target.agents.writer.messages).toEqual(seededWriterMessages);
        expect(target.agents.researcher.messages).toEqual(seededResearcherMessages);

        // Ids continue from the restored counters, and so does the store revision:
        // three events were restored, this add is the fourth. The new record is
        // attributed to the restored harness's primary.
        expect(await target.executeTool('task', { tasks: [{ text: 'Next' }] })).toEqual({
            tasks: [
                taskItem('1', 'Plan', { by: 'writer', at: EPOCH_ISO }),
                taskItem('2', 'Draft', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO }),
                taskItem('3', 'Next', { by: 'writer', at: EPOCH_ISO })
            ],
            counts: { total: 3, completed: 1, pending: 2 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 4
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

        // The persisted enabled set survives restore. An identical query is
        // idempotent: the uncapped selector returns all eleven every time.
        expect(await target.executeTool('toolRequest', { tags: ['bulk'] })).toEqual({
            enabled: [
                'bulk01',
                'bulk02',
                'bulk03',
                'bulk04',
                'bulk05',
                'bulk06',
                'bulk07',
                'bulk08',
                'bulk09',
                'bulk10',
                'bulk11'
            ],
            tools: Array.from({ length: 11 }, (_, index) => {
                const name = `bulk${String(index + 1).padStart(2, '0')}`;
                return { name, description: `Bulk tool ${name}.`, tags: ['bulk'] };
            }),
            matched: 11,
            omitted: 0
        });
        expect(target.discoveredTools).toEqual([
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'bulk06',
            'bulk07',
            'bulk08',
            'bulk09',
            'bulk10',
            'bulk11',
            'repeat'
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
        // R9-R11: restore republishes the declared core pair (plus delegate, because
        // this harness has subagents), the session-created tool, and the eleven
        // bulk tools the snapshot carried as enabled. The demoted runtime rows are
        // registered but not declared.
        expect((seen[0].tools ?? []).map((declaration) => declaration.name)).toEqual([
            'toolRequest',
            'task',
            'delegate',
            'repeat',
            'bulk01',
            'bulk02',
            'bulk03',
            'bulk04',
            'bulk05',
            'bulk06',
            'bulk07',
            'bulk08',
            'bulk09',
            'bulk10',
            'bulk11'
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
                // An untouched T1 store still serializes `storeRev: 0` and the empty
                // feed, because `snapshot()` always emits both.
                todos: { items: [], nextId: 1, storeRev: 0, changes: [] },
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

        const toolArguments = '{"tasks":[{"text":"Durable"}]}';
        let calls = 0;

        const stream: HarnessStream = async function* () {
            calls++;

            if (calls === 1) {
                yield {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'c1', name: 'task', arguments: toolArguments }]
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
            items: [taskItem('1', 'Durable', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })],
            nextId: 2,
            storeRev: 1,
            changes: [taskEvent(1, '1', 'add', { by: 'writer', threadId: 'agent:writer', itemRev: 1 })]
        });
        expect(checkpoint.agents.writer.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'task', arguments: toolArguments }]
            },
            {
                role: 'tool',
                content:
                    '{"tasks":[{"id":"1","text":"Durable","completed":false,"rev":1,"updatedBy":"writer","updatedThreadId":"agent:writer","updatedAt":"2026-01-01T00:00:00.000Z"}],"counts":{"total":1,"completed":0,"pending":1},"page":{"offset":0,"limit":20,"hasMore":false},"storeRev":1}',
                toolCallId: 'c1',
                name: 'task'
            }
        ]);

        // A direct read at the pause returns the same coherent checkpoint.
        expect(session.snapshot()).toEqual(checkpoint);

        releaseResolve();
        await running;

        // Restart from the interrupted-turn checkpoint. Restore must not replay
        // task: the store already contains exactly one item.
        const target = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream: scripted([answer('unused')]) }) },
            presets: false
        });
        target.restore(checkpoint);

        expect(target.snapshot()).toEqual(checkpoint);
        expect(await target.executeTool('task', {})).toEqual({
            tasks: [taskItem('1', 'Durable', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
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

    // -----------------------------------------------------------------------
    // T1: the task store's persisted half changed shape, and BOTH directions have
    // to hold: an old file restores with documented defaults, and a field the
    // current schema does not describe is reported instead of dropped.
    // -----------------------------------------------------------------------

    // A pre-T1 `records.todos` block: no `rev` on any record, and no `storeRev` or
    // `changes` on the store. Snapshot version 1 did not change, so this is a real
    // file a live server has on disk.
    const legacyTodos = {
        items: [
            { id: '1', text: 'Legacy open', completed: false },
            { id: '2', text: 'Legacy done', completed: true }
        ],
        nextId: 3
    };

    it('restores a pre-T1 task store with the documented defaults', async () => {
        const valid = await seedSmall();
        const target = buildSession();
        const restored = clone(valid) as unknown as HarnessSnapshot;

        (restored.records as unknown as { todos: unknown }).todos = clone(legacyTodos);
        target.restore(restored);

        // `rev` is the revision a record was CREATED with, and an old file has no
        // history at all: storeRev 0, empty feed. Nothing is invented.
        expect(target.snapshot().records.todos).toEqual({
            items: [
                taskItem('1', 'Legacy open'),
                taskItem('2', 'Legacy done', { completed: true })
            ],
            nextId: 3,
            storeRev: 0,
            changes: []
        });

        // The next write is a normal guarded write from rev 1, so a resumed session
        // can use every T1 verb immediately — and the feed starts from zero.
        expect(
            await target.executeTool('task', {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }]
            })
        ).toEqual({
            tasks: [
                taskItem('1', 'Legacy open', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO }),
                taskItem('2', 'Legacy done', { completed: true })
            ],
            counts: { total: 2, completed: 2, pending: 0 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
        });
    });

    it('re-saves a legacy task store in the current shape, without inventing history', async () => {
        const valid = await seedSmall();
        const target = buildSession();
        const restored = clone(valid) as unknown as HarnessSnapshot;

        (restored.records as unknown as { todos: unknown }).todos = clone(legacyTodos);
        target.restore(restored);

        const normalized = target.snapshot();

        // A restore that changes nothing observable must not invent events either:
        // snapshotting straight back is the same defaulted block, so a host that
        // saves on every notification cannot grow a feed out of a legacy file.
        expect(normalized.records.todos).toEqual({
            items: [taskItem('1', 'Legacy open'), taskItem('2', 'Legacy done', { completed: true })],
            nextId: 3,
            storeRev: 0,
            changes: []
        });

        // ...and the normalized file is a fixed point: restoring it again reproduces
        // it byte for byte, which is what makes a rolling upgrade safe.
        target.restore(normalized);
        expect(target.snapshot()).toEqual(normalized);
    });

    it('rejects a task record or change field the persisted schema does not describe', async () => {
        // A typo in a persisted T1 field is data loss, so it fails loudly.
        await restoreRejects((snapshot) => {
            (snapshot.records.todos.items[0] as unknown as Record<string, unknown>).reve = 2;
        }, /todo state\.items\[0\] has an unknown field "reve"\./);

        await restoreRejects((snapshot) => {
            (snapshot.records.todos.items[0] as unknown as Record<string, unknown>).rev = 0;
        }, /todo state\.items\[0\]\.rev must be between 1 and Infinity\./);

        // `leaseUntil` protects a HOLDER; an expiry with no owner protects nothing.
        await restoreRejects((snapshot) => {
            (snapshot.records.todos.items[0] as unknown as Record<string, unknown>).leaseUntil =
                LEASE_UNTIL;
        }, /todo state\.items\[0\]\.leaseUntil needs "owner"\./);

        await restoreRejects((snapshot) => {
            (snapshot.records.todos.items[0] as unknown as Record<string, unknown>).leaseUntil = 'soon';
        }, /todo state\.items\[0\]\.leaseUntil must be a finite positive number\./);

        // The feed itself: an unknown store key, an op the tool never logs, and a
        // log that does not rise.
        await restoreRejects((snapshot) => {
            (snapshot.records.todos as unknown as Record<string, unknown>).revision = 1;
        }, /todo state has an unknown field "revision"\./);

        await restoreRejects((snapshot) => {
            const todos = snapshot.records.todos as unknown as { changes: Record<string, unknown>[] };

            todos.changes[0].op = 'explode';
        }, /todo state\.changes\[0\]\.op must be one of: add, update, remove, claim, release\./);

        await restoreRejects((snapshot) => {
            const todos = snapshot.records.todos as unknown as {
                changes: unknown[];
                storeRev: number;
            };

            // Two events at revs 1 and 2, handed back newest-first. The revisions are
            // legal for the store; only the ORDER is wrong.
            todos.changes = [
                taskEvent(2, '1', 'update', { by: 'writer', fields: ['text'], itemRev: 2 }),
                taskEvent(1, '1', 'add', { by: 'writer', itemRev: 1 })
            ];
            todos.storeRev = 2;
        }, /todo state\.changes must be ordered by a rising rev; 1 follows 2\./);

        // A feed that runs ahead of the revision it was written under is the same
        // corruption in the other direction: every event is bounded by `storeRev`.
        await restoreRejects((snapshot) => {
            (snapshot.records.todos as unknown as Record<string, unknown>).storeRev = 0;
        }, /todo state\.changes\[0\]\.rev must be between 1 and 0\./);

        // `fields` names content fields only, and never a field twice.
        await restoreRejects((snapshot) => {
            const todos = snapshot.records.todos as unknown as { changes: Record<string, unknown>[] };

            todos.changes[0].fields = ['owner'];
        }, /todo state\.changes\[0\]\.fields entries must be one of: text, completed\./);

        await restoreRejects((snapshot) => {
            const todos = snapshot.records.todos as unknown as { changes: Record<string, unknown>[] };

            todos.changes[0].fields = ['text', 'text'];
        }, /todo state\.changes\[0\]\.fields lists "text" more than once\./);

        await restoreRejects((snapshot) => {
            (snapshot.records.todos.items[0] as unknown as Record<string, unknown>).completed =
                'true';
        }, /todo state\.items\[0\]\.completed must be a boolean\./);
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
                callTool('c1', 'task', '{"tasks":[{"text":"Persist me"}]}'),
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
            { type: 'state_change', reason: 'tool_execute', agent: 'writer', tool: 'task' },
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

        await writer.executeTool('task', { tasks: [{ text: 'Still here' }] });

        expect(await writer.executeTool('task', {})).toEqual({
            tasks: [taskItem('1', 'Still here', { by: 'writer', at: EPOCH_ISO })],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
        });
    });
});

// ---------------------------------------------------------------------------
// T1 — a claim, a content revision and the change feed are PERSISTED state
// ---------------------------------------------------------------------------
//
// The whole point of the T1 fields is that a process restart cannot hand a session
// back a store whose concurrent-edit protection has silently reset. `restore()`
// must reproduce `rev`, the attribution, the holder pair + lease, and the feed
// window exactly — and it must still lift a claim whose conversation the file does
// not carry (src/harness.ts clears those right after the store restore).

describe('task store snapshot/restore (T1)', () => {
    // A one-agent harness (no bulk catalogue), so `callTool` has exactly one agent
    // to name and `createThread` has one owner. Used for the "another holder" side of
    // these cases, where the identity of the caller is the fact under test.
    const writerOnlySession = (): { session: Harness; writer: Agent } => {
        const writerAgent = agent({
            model: 'merge/ds4-flash',
            instruction: 'Write.',
            messages: [
                { role: 'user', content: 'seed question' },
                { role: 'assistant', content: 'seed answer' }
            ],
            stream: scripted([answer('fresh')])
        });

        return {
            session: harness({ agents: { writer: writerAgent }, primary: 'writer', presets: false }),
            writer: writerAgent
        };
    };

    // One harness with a patched AND claimed record, so a snapshot has content
    // revisions, attribution, ownership keys and several feed entries at once. The
    // Agent object comes back too: `harness.callTool` is the door that carries an
    // explicit (agent, thread) identity, which is how a test expresses "a different
    // holder is trying to write".
    const seedClaimed = async (): Promise<{ session: Harness; writer: Agent }> => {
        const pair = writerOnlySession();

        await pair.session.executeTool('task', { tasks: [{ text: 'Write chapter one' }] });
        await pair.session.executeTool('task', {
            tasks: [{ id: '1', text: 'Write chapter one, then two' }],
            expects: [{ id: '1', rev: 1 }]
        });
        await pair.session.executeTool('task', {
            claim: ['1'],
            leaseMs: TASK_DEFAULT_LEASE_MS
        });

        return pair;
    };

    it('round-trips rev, attribution, the claim and the feed through JSON', async () => {
        const { session: source, writer } = await seedClaimed();
        const snapshot = source.snapshot();

        // The exact persisted block: an unthreaded `executeTool` claim keeps only
        // the (owner, no-thread) half of the holder pair (src/core/task.ts
        // setClaim), and every feed entry is stamped at the frozen instant.
        expect(snapshot.records.todos).toEqual({
            items: [
                taskItem('1', 'Write chapter one, then two', {
                    rev: 2,
                    by: 'writer',
                    at: EPOCH_ISO,
                    owner: 'writer',
                    leaseUntil: LEASE_UNTIL
                })
            ],
            nextId: 2,
            storeRev: 3,
            changes: [
                taskEvent(1, '1', 'add', { by: 'writer', itemRev: 1 }),
                taskEvent(2, '1', 'update', { by: 'writer', fields: ['text'], itemRev: 2 }),
                taskEvent(3, '1', 'claim', { by: 'writer' })
            ]
        });

        expectJsonShaped(snapshot);
        const json = JSON.parse(JSON.stringify(snapshot));

        expect(json).toEqual(snapshot);

        // The target has the SAME agent roster as the source: restore refuses an
        // agent the file does not carry, so this is a like-for-like session.
        const targetPair = writerOnlySession();
        const target = targetPair.session;
        target.restore(json);

        // Byte-identical store after a real restore, and the lease survived as the
        // exact epoch-ms instant rather than "some number".
        expect(target.snapshot().records.todos).toEqual(snapshot.records.todos);

        // The reader-facing contract survived too: `since` replays the same three
        // events, and the record is still rev 2 with the same holder.
        const page = (await target.executeTool('task', { since: 0 })) as TaskResult & {
            changes: TaskChange[];
        };

        expect(page.tasks).toEqual([
            taskItem('1', 'Write chapter one, then two', {
                rev: 2,
                by: 'writer',
                at: EPOCH_ISO,
                owner: 'writer',
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(page.storeRev).toBe(3);
        expect(page.changes).toEqual(snapshot.records.todos.changes);

        // A claim that crossed the restart still BLOCKS. The restored holder pair is
        // (writer, no thread); a caller ON a conversation is a DIFFERENT pair, so the
        // resumed session refuses that foreign content write with the same message
        // the source session would have used.
        const foreignPair = writerOnlySession();
        const foreign = foreignPair.session;
        foreign.restore(json);
        const thread = foreign.createThread('writer');

        await expect(
            foreign.callTool(
                'task',
                { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 2 }] },
                { agent: foreignPair.writer, threadId: thread.id }
            )
        ).rejects.toThrow(
            `task "1" is claimed by "writer" until ${new Date(LEASE_UNTIL).toISOString()}; release it or take it over first.`
        );

        // ...and the takeover the resumed session CAN make continues the restored
        // feed rather than restarting it: event 4 is the new claim, and `rev` is
        // still 2 — an ownership action never moves a content revision.
        const taken = (await foreign.callTool(
            'task',
            { takeover: ['1'] },
            { agent: foreignPair.writer, threadId: thread.id }
        )) as TaskResult;

        expect(taken.tasks).toEqual([
            taskItem('1', 'Write chapter one, then two', {
                rev: 2,
                by: 'writer',
                threadId: thread.id,
                at: EPOCH_ISO,
                owner: 'writer',
                ownerThreadId: thread.id,
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(taken.storeRev).toBe(4);
    });

    it('drops a restored claim whose conversation the snapshot does not carry', async () => {
        const { session: source } = await seedClaimed();
        const snapshot = source.snapshot();

        // A claim taken on a thread that is gone (deleted after the snapshot, or a
        // hand-edited file). The thread id is unaddressable in the resumed session,
        // so nothing could ever lift the lock again — src/harness.ts releases it.
        (snapshot.records.todos.items[0] as TaskItem).ownerThreadId = 'thread-gone';

        // The target has the SAME agent roster as the source (restore refuses an
        // agent the file does not carry).
        const target = writerOnlySession().session;
        target.restore(snapshot);
        expect(target.snapshot().records.todos.items).toEqual([
            taskItem('1', 'Write chapter one, then two', { rev: 2, by: 'writer', at: EPOCH_ISO })
        ]);

        // `releaseThread` is itself a recorded event, so the drop is visible to a
        // reader polling the feed — and it names the thread, with no `by`, unlike a
        // voluntary release.
        expect(target.snapshot().records.todos.storeRev).toBe(4);
        expect(target.snapshot().records.todos.changes?.[3]).toEqual(
            taskEvent(4, '1', 'release', { threadId: 'thread-gone' })
        );

        // Free to write now: the guarded patch lands, and the store keeps the
        // restored history instead of restarting it (event 5 is the update on top of
        // the four events the file carried).
        expect(
            await target.executeTool('task', {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 2 }]
            })
        ).toEqual({
            tasks: [
                taskItem('1', 'Write chapter one, then two', {
                    completed: true,
                    rev: 3,
                    by: 'writer',
                    at: EPOCH_ISO
                })
            ],
            counts: { total: 1, completed: 1, pending: 0 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 5
        });
    });
});
