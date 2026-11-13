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
// The built-in collection SPECS (records-engine T3): a v2 snapshot stores each
// collection's definition beside its entries (Decision M), so every fixture and every
// expectation below names the spec it restores against. The lease constant this line
// used to import died with Decision P.
import {
    CHAPTERS_COLLECTION,
    LOCATIONS_COLLECTION,
    PROFILES_COLLECTION,
    TASKS_COLLECTION
} from './core';
// The read rule for the persisted tool outcome (compaction T1). Imported from the module,
// like ./core/task above, so the round-trip assertions below pin the SAME helper a policy
// uses rather than re-spelling `?? 'completed'` in a test.
import { toolOutcomeOf, toolResultIsError } from './core/tool-outcome';
import type {
    Agent,
    Harness,
    HarnessAttachment,
    HarnessMessage,
    HarnessPluginApi,
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

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

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
    // No owner / ownerThreadId / leaseUntil: Decision P deleted the lock, so a
    // persisted claim field is reported as an unknown field, never restored.
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
        // ONE store, ONE counter (records-engine F3/T3): the ids below are the seed
        // order across ALL collections — tasks 1,2 then profile 3 then chapters 4,5
        // then location 6 — and the store-level nextId is one past the largest.
        nextId: 7,
        collections: {
            // Every record carries its content revision and its writer, and the
            // collection keeps `storeRev` plus its own bounded change feed (Decision B)
            // so a resumed session can answer `since` without replaying anything.
            tasks: {
                definition: TASKS_COLLECTION,
                items: [
                    taskItem('1', 'Plan', { by: 'writer', at: EPOCH_ISO }),
                    taskItem('2', 'Draft', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO })
                ],
                storeRev: 3,
                changes: [
                    taskEvent(1, '1', 'add', { by: 'writer', itemRev: 1 }),
                    taskEvent(2, '2', 'add', { by: 'writer', itemRev: 1 }),
                    taskEvent(3, '2', 'update', { by: 'writer', fields: ['completed'], itemRev: 2 })
                ]
            },
            chapters: {
                definition: CHAPTERS_COLLECTION,
                items: [
                    {
                        id: '4',
                        title: 'Arrival',
                        summary: 'They arrive.',
                        content: 'Body.',
                        status: 'draft',
                        order: 2,
                        rev: 1,
                        updatedBy: 'writer',
                        updatedAt: EPOCH_ISO
                    },
                    {
                        id: '5',
                        title: 'Return',
                        summary: 'They return.',
                        content: '',
                        status: 'planned',
                        rev: 1,
                        updatedBy: 'writer',
                        updatedAt: EPOCH_ISO
                    }
                ],
                storeRev: 2,
                changes: [
                    taskEvent(1, '4', 'add', { by: 'writer', itemRev: 1 }),
                    taskEvent(2, '5', 'add', { by: 'writer', itemRev: 1 })
                ]
            },
            profiles: {
                definition: PROFILES_COLLECTION,
                items: [
                    {
                        id: '3',
                        name: 'Elena',
                        description: 'A cartographer.',
                        traits: ['cartographer', 'pilot'],
                        notes: 'Travels.',
                        rev: 1,
                        updatedBy: 'writer',
                        updatedAt: EPOCH_ISO
                    }
                ],
                storeRev: 1,
                changes: [taskEvent(1, '3', 'add', { by: 'writer', itemRev: 1 })]
            },
            locations: {
                definition: LOCATIONS_COLLECTION,
                items: [
                    {
                        id: '6',
                        name: 'Harbor',
                        description: 'A port.',
                        notes: 'Fog.',
                        rev: 1,
                        updatedBy: 'writer',
                        updatedAt: EPOCH_ISO
                    }
                ],
                storeRev: 1,
                changes: [taskEvent(1, '6', 'add', { by: 'writer', itemRev: 1 })]
            }
        }
    }
});

// Populate the source harness through the public manual path, in an order that
// leaves one untouched discovery offset.
const seedSource = async (): Promise<Harness> => {
    const writer = buildSession();

    await writer.executeTool('toolRequest', { tags: ['bulk'] });
    await writer.executeTool('toolCreate', repeatCreation);

    await writer.executeTool('tasks', { tasks: [{ text: 'Plan' }] });
    await writer.executeTool('tasks', { tasks: [{ text: 'Draft' }] });
    // A guarded write (executeTool runs as the primary agent) needs the token the
    // caller read: id "2" was added at content rev 1 (src/core/task.ts).
    await writer.executeTool('tasks', {
        tasks: [{ id: '2', completed: true }],
        expects: [{ id: '2', rev: 1 }]
    });

    await writer.executeTool('profiles', {
        action: 'add',
        name: 'Elena',
        description: 'A cartographer.',
        traits: ['cartographer', 'pilot'],
        notes: 'Travels.'
    });

    await writer.executeTool('chapters', {
        action: 'add',
        title: 'Arrival',
        summary: 'They arrive.',
        content: 'Body.',
        status: 'draft',
        order: 2
    });
    await writer.executeTool('chapters', {
        action: 'add',
        title: 'Return',
        summary: 'They return.'
    });

    await writer.executeTool('locations', {
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
    await writer.executeTool('tasks', { tasks: [{ text: 'One' }] });
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
        expect(withoutIds(snapshot)).toEqual(buildExpectedSnapshot());

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
        expect(withoutIds(target.agents.writer.messages)).toEqual(seededWriterMessages);
        expect(withoutIds(target.agents.researcher.messages)).toEqual(seededResearcherMessages);

        // Ids continue from the restored counters, and so does the store revision:
        // three events were restored, this add is the fourth. The new record is
        // attributed to the restored harness's primary.
        expect(await target.executeTool('tasks', { tasks: [{ text: 'Next' }] })).toEqual({
            tasks: [
                taskItem('1', 'Plan', { by: 'writer', at: EPOCH_ISO }),
                taskItem('2', 'Draft', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO }),
                taskItem('7', 'Next', { by: 'writer', at: EPOCH_ISO })
            ],
            counts: { total: 3, completed: 1, pending: 2 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 4,
            // R1/T1.1 — this add affected exactly ONE record, so the restored store
            // also answers with that record as `entry` beside the page. Reads and
            // multi-record calls in this file keep the page-only shape, which is the
            // assertion that the key is conditional rather than always present.
            entry: taskItem('7', 'Next', { by: 'writer', at: EPOCH_ISO })
        });

        // Record bodies and trait arrays survived the copy.
        expect(await target.executeTool('profiles', { action: 'get', id: '3' })).toEqual({
            profile: {
                id: '3',
                name: 'Elena',
                description: 'A cartographer.',
                traits: ['cartographer', 'pilot'],
                notes: 'Travels.',
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            counts: { total: 1 }
        });
        expect(await target.executeTool('chapters', { action: 'get', id: '4' })).toEqual({
            chapter: {
                id: '4',
                title: 'Arrival',
                summary: 'They arrive.',
                status: 'draft',
                order: 2,
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            // The body rides beside the summary — the wrapper contract the tool's own
            // description states ('"get" returns { chapter, content, counts }').
            content: 'Body.',
            counts: { total: 2, planned: 1, draft: 1, complete: 0 }
        });
        expect(await target.executeTool('locations', { action: 'list' })).toEqual({
            locations: [
                {
                    id: '6',
                    name: 'Harbor',
                    description: 'A port.',
                    notes: 'Fog.',
                    rev: 1,
                    updatedBy: 'writer',
                    updatedAt: EPOCH_ISO
                }
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
            'tasks',
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
        expect(withoutIds(session.snapshot())).toEqual({
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
                // An untouched store still serializes `storeRev: 0` and the empty feed
                // for every collection, because `snapshot()` always emits both — and it
                // carries ONE counter at the store level (F3).
                nextId: 1,
                collections: {
                    tasks: { definition: TASKS_COLLECTION, items: [], storeRev: 0, changes: [] },
                    chapters: { definition: CHAPTERS_COLLECTION, items: [], storeRev: 0, changes: [] },
                    profiles: { definition: PROFILES_COLLECTION, items: [], storeRev: 0, changes: [] },
                    locations: { definition: LOCATIONS_COLLECTION, items: [], storeRev: 0, changes: [] }
                }
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
                    toolCalls: [{ id: 'c1', name: 'tasks', arguments: toolArguments }]
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

        expect(checkpoint.records.collections.tasks).toEqual({
            definition: TASKS_COLLECTION,
            items: [taskItem('1', 'Durable', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })],
            storeRev: 1,
            changes: [taskEvent(1, '1', 'add', { by: 'writer', threadId: 'agent:writer', itemRev: 1 })]
        });
        expect(withoutIds(checkpoint.agents.writer.messages)).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'tasks', arguments: toolArguments }]
            },
            {
                role: 'tool',
                content:
                    '{"tasks":[{"id":"1","text":"Durable","completed":false,"rev":1,"updatedBy":"writer","updatedThreadId":"agent:writer","updatedAt":"2026-01-01T00:00:00.000Z"}],"counts":{"total":1,"completed":0,"pending":1},"page":{"offset":0,"limit":20,"hasMore":false},"storeRev":1,"entry":{"id":"1","text":"Durable","completed":false,"rev":1,"updatedBy":"writer","updatedThreadId":"agent:writer","updatedAt":"2026-01-01T00:00:00.000Z"}}',
                toolCallId: 'c1',
                name: 'tasks'
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
        expect(await target.executeTool('tasks', {})).toEqual({
            tasks: [taskItem('1', 'Durable', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
        });
    });
});

// ---------------------------------------------------------------------------
// Context inclusion (Stage 1a) — the flag is PERSISTED state
// ---------------------------------------------------------------------------

describe('snapshot persistence of the context-inclusion flag', () => {
    // The transcript under test: a completed tool unit whose RESULT is disabled.
    // Unit semantics (types/index.ts `HarnessMessage`) then withhold the assistant
    // block as a whole, so persistence and projection are covered by one fixture.
    const flaggedWriterMessages = (): HarnessMessage[] => [
        { role: 'system', content: 'Write.' },
        { role: 'user', content: 'seed question' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'bulk01', arguments: '{}' }]
        },
        { role: 'tool', content: 'found', toolCallId: 'c1', name: 'bulk01', included: false },
        { role: 'assistant', content: 'seed answer' }
    ];

    // The same session, built by inserting the unit into the seeded transcript so
    // the agent set stays identical to what `buildSession()` restores into.
    const flaggedSession = (): Harness => {
        const session = buildSession();
        const unit = flaggedWriterMessages().slice(2, 4);
        session.agents.writer.messages.splice(2, 0, ...unit);
        return session;
    };

    it('never writes the key while no turn is disabled', async () => {
        expect(JSON.stringify(buildSession().snapshot())).not.toContain('included');
    });

    it('persists `included: false`, restores it byte-for-byte, and keeps withholding that ONE entry after a restart', async () => {
        const snapshot = clone(flaggedSession().snapshot());

        // `snapshot()` runs the SAME reader `restore()` enforces, so the flagged
        // entry is exactly what a host will find on disk, and its unflagged
        // neighbours carry no `included` key at all.
        expect(withoutIds(snapshot.agents.writer.messages)).toEqual(flaggedWriterMessages());

        const seen: HarnessStreamRequest[] = [];
        const target = buildSession({ turns: [answer('after restore')], seen });
        target.restore(snapshot);

        expect(withoutIds(target.agents.writer.messages)).toEqual(flaggedWriterMessages());
        // Re-saving is lossless and stable: the flag survives, nothing is added.
        expect(target.snapshot()).toEqual(snapshot);

        // Restore is idempotent for a flagged transcript too (it replaces, never
        // duplicates, and never normalizes a `false` back to the default).
        target.restore(snapshot);
        expect(target.snapshot()).toEqual(snapshot);

        // The restored flag is LIVE state, and since R8 it is the ONE entry it was written
        // on: the request keeps the assistant `toolCalls` entry (its own flag was never
        // written) and answers that call with the request-only `status: 'withheld'`
        // placeholder, in the slot the disabled result vacated
        // (../harness.ts `projectTranscript`). Nothing else moved.
        await target('continue');

        expect(seen[seen.length - 1].messages).toEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'seed question' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bulk01', arguments: '{}' }] },
            {
                role: 'tool',
                toolCallId: 'c1',
                name: 'bulk01',
                content: JSON.stringify({
                    status: 'withheld',
                    callId: 'c1',
                    name: 'bulk01',
                    note: 'The result of this tool call is withheld from your context, so its content is not available to you. The call already finished; do not re-run it just because the answer is missing.'
                })
            },
            { role: 'assistant', content: 'seed answer' },
            { role: 'user', content: 'continue' }
        ]);
        expect(JSON.stringify(seen[seen.length - 1].messages)).not.toContain('included');
        expect(withoutIds(target.agents.writer.messages)).toEqual([
            ...flaggedWriterMessages(),
            { role: 'user', content: 'continue' },
            { role: 'assistant', content: 'after restore' }
        ]);
    });

    it('restores a pre-flag snapshot in which the key never appears', async () => {
        const snapshot = await seedSmall();
        const target = buildSession();

        expect(() => target.restore(clone(snapshot))).not.toThrow();
        expect(withoutIds(target.agents.writer.messages)).toEqual(seededWriterMessages);
        expect(JSON.stringify(target.snapshot())).not.toContain('included');
    });

    it('normalizes a hand-written `included: true` back to the omitted form', async () => {
        const edited = clone(await seedSmall());
        (edited.agents.writer.messages[1] as Record<string, unknown>).included = true;

        const target = buildSession();
        target.restore(edited);

        // Absent means included, and the runtime never writes `true`, so a re-save
        // drops the key instead of perpetuating a value the schema does not use.
        expect(withoutIds(target.agents.writer.messages[1])).toEqual({ role: 'user', content: 'seed question' });
        expect(JSON.stringify(target.snapshot())).not.toContain('included');
    });

    // -----------------------------------------------------------------------
    // Context T1 — the persisted transcript address.
    //
    // `messageId` is OPTIONAL on read (a `state.json` written before ids existed must
    // keep restoring), and the reader BACKFILLS it: every path into canonical state goes
    // through `readHarnessMessages`, so minting here is the one place that can promise
    // a restored conversation is addressable from its very next round. The three tests
    // below pin the two halves of that decision plus its idempotence requirement.
    // -----------------------------------------------------------------------

    it('restores a transcript written before addresses existed, and mints them in transcript order', async () => {
        const preId = clone(await seedSmall());

        // A document from before T1: no entry carries the key at all.
        for (const name of Object.keys(preId.agents)) {
            preId.agents[name].messages = preId.agents[name].messages.map((message) => {
                const copy = { ...message } as Record<string, unknown>;
                delete copy.messageId;

                return copy as HarnessMessage;
            });
        }

        expect(JSON.stringify(preId.agents)).not.toContain('messageId');

        const target = buildSession();
        expect(() => target.restore(preId)).not.toThrow();

        // BACKFILL-ON-READ, numbered from the top of the transcript, because nothing in
        // the document claimed a number (src/core/message-id.ts counts per transcript).
        expect(target.agents.writer.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3'
        ]);

        // IDEMPOTENCE, the property `applyIncluded` already protects: an address that is
        // already there is carried verbatim, so `restore -> snapshot` hands the same
        // document back and a host that re-saves it does not renumber its conversation.
        const first = target.snapshot();
        target.restore(clone(first));
        expect(target.snapshot()).toEqual(first);
        expect(target.agents.writer.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3'
        ]);
    });

    it('honours the addresses a document carries and numbers the next entry above them', async () => {
        const source = clone(await seedSmall());
        source.agents.writer.messages = source.agents.writer.messages.map(
            (message, index) =>
                ({ ...message, messageId: `msg-${String(index + 9)}` }) as HarnessMessage
        );

        const target = buildSession();
        target.restore(source);

        // A copy never re-mints: the restored entries keep the ids the document named.
        expect(target.agents.writer.messages.map((message) => message.messageId)).toEqual([
            'msg-9',
            'msg-10',
            'msg-11'
        ]);

        // And the transcript's counter starts ABOVE what it restored, so the next
        // creation cannot collide with an id the file already owns — the same
        // reserve-from-max rule src/harness.ts applies to restored branch ids.
        await target('continue');
        expect(target.agents.writer.messages.map((message) => message.messageId)).toEqual([
            'msg-9',
            'msg-10',
            'msg-11',
            'msg-12',
            'msg-13'
        ]);
    });

    it('refuses a messageId that is not a usable address, and leaves the target untouched', async () => {
        const valid = await seedSmall();

        const notAString = clone(valid);
        (notAString.agents.writer.messages[1] as Record<string, unknown>).messageId = 7;

        const blank = clone(valid);
        (blank.agents.writer.messages[0] as Record<string, unknown>).messageId = '';

        const target = buildSession();
        const before = target.snapshot();

        // Refused rather than silently re-minted: the caller (a server transcript PUT, a
        // hand-edited file) has to learn its address was not taken seriously.
        expect(() => target.restore(notAString)).toThrow(
            'snapshot.agents["writer"].messages[1].messageId must be a string.'
        );
        expect(() => target.restore(blank)).toThrow(
            'snapshot.agents["writer"].messages[0].messageId must be at least 1 characters.'
        );
        expect(target.snapshot()).toEqual(before);
    });

    it('refuses an `included` value that is not a boolean and leaves the target untouched', async () => {
        const valid = await seedSmall();
        const invalid = clone(valid);
        (invalid.agents.writer.messages[1] as Record<string, unknown>).included = 'nope';

        const target = buildSession();
        const before = target.snapshot();

        expect(() => target.restore(invalid)).toThrow(
            'snapshot.agents["writer"].messages[1].included must be a boolean.'
        );
        expect(target.snapshot()).toEqual(before);
    });

    it('refuses an `included` value that is not a boolean INSIDE a host thread too', async () => {
        const source = agentSession([{ role: 'user', content: 'main' }]);
        const thread = source.createThread('writer', { label: 'Extra' });
        source.setThreadMessages(thread.id, [{ role: 'user', content: 'thread off', included: false }]);

        const invalid = clone(source.snapshot());
        (invalid.threads![0].messages[0] as Record<string, unknown>).included = 'nope';

        const target = agentSession([{ role: 'user', content: 'main' }]);
        const before = target.snapshot();

        // The thread reader is the one shared `readHarnessMessages`, so its labels
        // are the thread's own path — and a bad flag is refused there exactly like it
        // is in an agent transcript.
        expect(() => target.restore(invalid)).toThrow(
            `snapshot.threads[0].messages[0].included must be a boolean.`
        );
        expect(target.snapshot()).toEqual(before);
    });

    // One-agent session with a host-seeded transcript: the seed path is where a
    // caller's `included` enters canonical state (core/agent.ts `withIncluded`).
    const agentSession = (
        messages: HarnessMessage[],
        seen?: HarnessStreamRequest[]
    ): Harness =>
        harness({
            agents: {
                writer: agent({
                    model: 'merge/ds4-flash',
                    messages,
                    stream: scripted([answer('after restore')], seen)
                })
            },
            presets: false
        });

    // A minimal valid upload-profile image: the 12-byte PNG signature, the same
    // fixture shape src/core/snapshot.attachments.test.ts and src/server/transcript.test.ts
    // use, so a disabled turn can also carry bytes through a file.
    const PNG = (): HarnessAttachment => ({
        id: 'img-1',
        kind: 'image',
        marker: '[Image 1]',
        name: 'pixel.png',
        mime: 'image/png',
        size: 12,
        data: 'iVBORw0KGgoAAAAA'
    });

    it('keeps a disabled turn WITH its attachment through a round trip and still withholds it', async () => {
        const seeded: HarnessMessage[] = [
            { role: 'user', content: 'see [Image 1]', attachments: [PNG()], included: false },
            { role: 'user', content: 'plain' }
        ];

        const snapshot = clone(agentSession(seeded).snapshot());

        // Exclusion must not be an excuse to drop bytes: the persisted entry keeps
        // BOTH the attachment list and the flag, in the reader's key order.
        expect(withoutIds(snapshot.agents.writer.messages)).toStrictEqual([
            { role: 'user', content: 'see [Image 1]', attachments: [PNG()], included: false },
            { role: 'user', content: 'plain' }
        ]);

        const seen: HarnessStreamRequest[] = [];
        const target = agentSession(seeded, seen);
        target.restore(snapshot);

        expect(withoutIds(target.agent.messages)).toStrictEqual([
            { role: 'user', content: 'see [Image 1]', attachments: [PNG()], included: false },
            { role: 'user', content: 'plain' }
        ]);
        expect(target.snapshot()).toEqual(snapshot);

        await target('next');

        // Still withheld after the restart — and the request carries neither the
        // flag nor the attachment bytes, because the only message that had them is
        // absent from the model-facing transcript.
        const request = JSON.stringify(seen[seen.length - 1].messages);
        expect(seen[seen.length - 1].messages).toStrictEqual([
            { role: 'user', content: 'plain' },
            { role: 'user', content: 'next' }
        ]);
        expect(request).not.toContain('included');
        expect(request).not.toContain('attachments');
        expect(request).not.toContain('iVBORw0KGgoAAAAA');
    });

    it('preserves the flag in snapshot().threads[] and restores it with the host thread', async () => {
        const source = agentSession([{ role: 'user', content: 'main' }]);
        const thread = source.createThread('writer', { label: 'Extra' });
        source.setThreadMessages(thread.id, [
            { role: 'system', content: 'thread sys' },
            { role: 'user', content: 'thread off', included: false },
            { role: 'user', content: 'thread on', included: true }
        ]);

        const snapshot = clone(source.snapshot());

        // A host thread's transcript is persisted through the SAME reader, so the
        // disabled entry keeps its flag there too, and a hand-written `true` is
        // already normalized away before the file is ever written.
        expect(snapshot.threads).toHaveLength(1);
        expect(withoutIds(snapshot.threads![0].messages)).toStrictEqual([
            { role: 'system', content: 'thread sys' },
            { role: 'user', content: 'thread off', included: false },
            { role: 'user', content: 'thread on' }
        ]);

        const target = agentSession([{ role: 'user', content: 'main' }]);
        target.restore(snapshot);

        // No normalizer on either side: this is the `restore -> snapshot` round trip,
        // and what it proves now includes the transcript addresses coming back
        // byte-for-byte (context T1.3).
        expect(target.snapshot()).toEqual(snapshot);
        expect(withoutIds(target.threadMessages(thread.id))).toStrictEqual([
            { role: 'system', content: 'thread sys' },
            { role: 'user', content: 'thread off', included: false },
            { role: 'user', content: 'thread on' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// Compaction T1 — the persisted tool outcome (F2 of that entry)
// ---------------------------------------------------------------------------

// The classification a delivery computes is otherwise LOST the moment the run ends: the
// event stream is gone, and the committed entry carried only result prose. These tests pin
// the four properties the substrate depends on:
//   * a NON-`completed` outcome is persisted, verbatim, on the canonical message;
//   * a `completed` one is NOT (no key, no `"completed"` string), so a pre-outcome
//     snapshot and a post-T1 snapshot of the same healthy conversation are the same bytes;
//   * a snapshot round-trips (and re-saves identically) through the same strict reader a
//     `threadRead` and a branch record go through;
//   * a value outside the union is REFUSED, and an explicitly-written `completed` is
//     normalized back to the omitted form, exactly like `included: true` above.
describe('snapshot persistence of the tool outcome', () => {
    // One failed unit and one healthy unit, both INCLUDED, so the fixture isolates the new
    // key from the flag semantics pinned above.
    const outcomeWriterMessages = (): HarnessMessage[] => [
        { role: 'system', content: 'Write.' },
        { role: 'user', content: 'seed question' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'bulk01', arguments: '{}' }]
        },
        {
            role: 'tool',
            content: 'Tool "bulk01" failed: kaput',
            toolCallId: 'c1',
            name: 'bulk01',
            outcome: 'failed'
        },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c2', name: 'bulk02', arguments: '{}' }]
        },
        { role: 'tool', content: 'found', toolCallId: 'c2', name: 'bulk02' },
        { role: 'assistant', content: 'seed answer' }
    ];

    // The same session built by splicing the two units into the seeded transcript, so the
    // agent set stays identical to what `buildSession()` restores into.
    const outcomeSession = (): Harness => {
        const session = buildSession();
        session.agents.writer.messages.splice(2, 0, ...outcomeWriterMessages().slice(2, 6));
        return session;
    };

    it('writes no outcome key while every result completed, and reads a pre-outcome document as completed', async () => {
        // The omit rule in one assertion: a healthy transcript — every fixture in this file,
        // and every one an older build wrote — carries no `outcome` key at all.
        expect(JSON.stringify(await seedSmall())).not.toContain('"outcome"');
        expect(JSON.stringify(buildSession().snapshot())).not.toContain('"outcome"');

        // A PRE-OUTCOME document: this session with the classification taken back out, i.e.
        // exactly what is on disk for a conversation saved before T1.
        const snapshot = clone(outcomeSession().snapshot());
        delete (snapshot.agents.writer.messages[3] as Record<string, unknown>).outcome;

        const target = buildSession();
        target.restore(snapshot);

        const restored = target.agents.writer.messages[3] as Extract<
            HarnessMessage,
            { role: 'tool' }
        >;

        // ABSENT reads as `completed` (core/tool-outcome.ts `toolOutcomeOf`) — the only
        // reading that keeps every existing document valid with no migration. And NOTHING
        // reconstructs a failure from the prose: the text still says "failed" while the
        // stored fact stays absent, because there is deliberately no string-matching bridge
        // (T1.5). A policy therefore never prunes on such an entry alone (T0 Q3).
        expect(restored.content).toBe('Tool "bulk01" failed: kaput');
        expect('outcome' in restored).toBe(false);
        expect(toolOutcomeOf(restored)).toBe('completed');
        expect(toolResultIsError(restored)).toBe(false);
    });

    it('persists a failed outcome, restores it byte-for-byte, and re-saves identically', async () => {
        const snapshot = clone(outcomeSession().snapshot());

        // `snapshot()` runs the same reader `restore()` enforces, so what a host sees on disk
        // is exactly the stored form: the failure carries its value, the healthy sibling
        // carries nothing.
        expect(withoutIds(snapshot.agents.writer.messages)).toEqual(outcomeWriterMessages());

        const seen: HarnessStreamRequest[] = [];
        const target = buildSession({ turns: [answer('after restore')], seen });
        target.restore(snapshot);

        expect(withoutIds(target.agents.writer.messages)).toEqual(outcomeWriterMessages());
        expect(target.snapshot()).toEqual(snapshot);

        // Restore is idempotent for a classified transcript too, and `completed` never
        // creeps back in on a re-save.
        target.restore(snapshot);
        expect(target.snapshot()).toEqual(snapshot);
        expect(JSON.stringify(target.snapshot())).toContain('"outcome":"failed"');
        expect(JSON.stringify(target.snapshot())).not.toContain('"outcome":"completed"');

        await target('continue');

        // The model-facing PROJECTION keeps the outcome (`withIncluded` strips only
        // `included`/`messageId`), so a `turn.before` policy can read WHY a call ended from
        // the very transcript it is being asked about. The provider payload itself is
        // field-selected by the transport and stays unchanged — pinned in
        // src/transport/openai.test.ts.
        const projected = seen[seen.length - 1].messages.filter(
            (message) => message.role === 'tool'
        );
        expect(projected).toEqual([
            {
                role: 'tool',
                content: 'Tool "bulk01" failed: kaput',
                toolCallId: 'c1',
                name: 'bulk01',
                outcome: 'failed'
            },
            { role: 'tool', content: 'found', toolCallId: 'c2', name: 'bulk02' }
        ]);
    });

    it('normalizes a hand-written `outcome: "completed"` back to the omitted form', () => {
        const snapshot = clone(outcomeSession().snapshot());
        // A host that spelled the healthy value out instead of omitting it.
        (snapshot.agents.writer.messages[5] as Record<string, unknown>).outcome = 'completed';

        const target = buildSession();
        target.restore(snapshot);

        // The runtime never writes `completed`, so a re-save drops it rather than
        // perpetuating a second spelling of the same fact (the `included: true` rule).
        expect(withoutIds(target.agents.writer.messages[5])).toEqual({
            role: 'tool',
            content: 'found',
            toolCallId: 'c2',
            name: 'bulk02'
        });
        // The real failure is untouched by that normalization.
        expect((target.agents.writer.messages[3] as { outcome?: string }).outcome).toBe('failed');
        expect(JSON.stringify(target.snapshot())).not.toContain('"outcome":"completed"');
    });

    it('refuses an outcome outside the union and leaves the target untouched', () => {
        const invalid = clone(outcomeSession().snapshot());
        (invalid.agents.writer.messages[3] as Record<string, unknown>).outcome = 'fail';

        const target = buildSession();
        const before = target.snapshot();

        // Refused, not read as healthy: a mistyped classification that silently became
        // `completed` would hide a failure from every policy that prunes on one.
        expect(() => target.restore(invalid)).toThrow(
            'snapshot.agents["writer"].messages[3].outcome must be one of: completed, failed, rejected, cancelled (or be omitted).'
        );
        expect(target.snapshot()).toEqual(before);
    });

    it('persists the outcome of a thread transcript and restores it with the thread', () => {
        const source = buildSession();
        const thread = source.createThread('writer', { label: 'Outcome' });
        source.setThreadMessages(thread.id, [
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'bulk01', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'Tool "bulk01" was cancelled before it produced a value.',
                toolCallId: 'c1',
                name: 'bulk01',
                outcome: 'cancelled'
            }
        ]);

        const snapshot = clone(source.snapshot());

        // The thread reader IS the shared `readHarnessMessages`, so the tool allowlist and
        // this key apply to a host thread exactly as they do to an agent transcript.
        expect(withoutIds(snapshot.threads![0].messages)).toEqual([
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'bulk01', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'Tool "bulk01" was cancelled before it produced a value.',
                toolCallId: 'c1',
                name: 'bulk01',
                outcome: 'cancelled'
            }
        ]);

        const target = buildSession();
        target.restore(snapshot);

        // Restored with the thread: `toStrictEqual` so the key set itself is pinned — the
        // classification is there, and the healthy entries around it gained nothing.
        expect(
            target.threadMessages(thread.id)[1]
        ).toStrictEqual({
            role: 'tool',
            content: 'Tool "bulk01" was cancelled before it produced a value.',
            toolCallId: 'c1',
            name: 'bulk01',
            outcome: 'cancelled',
            messageId: expect.any(String)
        });
        expect(target.snapshot()).toEqual(snapshot);
    });
});

// ---------------------------------------------------------------------------
// Validation / no partial application
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pipeline T3 — an entry EDIT is persisted state, not a request-only rewrite
// ---------------------------------------------------------------------------

describe('snapshot persistence of an entry edit', () => {
    // One host plugin re-wording one entry through the real `turn.before` control
    // surface. The `find` guard makes the write one-shot: after the first round no entry
    // still carries the old text, so a later round of the same run changes nothing.
    const editPlugin = (from: string, to: string) => ({
        name: `edit-${to}`,
        setup: (api: HarnessPluginApi) => {
            api.on('turn.before', (context) => {
                const target = context.entries.find(
                    (candidate) => candidate.message.content === from
                );

                if (target === undefined) return;

                context.edit(target, { content: to });
            });
        }
    });

    const editSession = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): Harness =>
        harness({
            agents: {
                writer: agent({
                    model: 'merge/ds4-flash',
                    instruction: 'Write.',
                    messages: [{ role: 'user', content: 'seed question' }],
                    stream: scripted(turns, seen)
                })
            },
            presets: false,
            plugins: [editPlugin('seed question', 'edited seed')]
        });

    it('persists the edited text through JSON and serves it after a restart', async () => {
        const seen: HarnessStreamRequest[] = [];
        const source = editSession([answer('settled')], seen);

        await source('go');

        // (1) The request the edit was made for already carried the new text (T3.2), so
        //     the run that made it is the run that used it.
        expect(seen[0].messages.map((message) => message.content)).toEqual([
            'Write.',
            'edited seed',
            'go'
        ]);

        const snapshot = clone(source.snapshot());

        // (2) The persisted document carries the new text and NOTHING ELSE moved. Every
        //     message keeps its exact key set: an edit writes fields the per-role
        //     whitelists already list, which is why no whitelist had to change (T3.6),
        //     and no `included` key appeared on the way.
        expect(withoutIds(snapshot.agents.writer.messages)).toEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'edited seed' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'settled' }
        ]);
        expect(
            snapshot.agents.writer.messages.map((message) => Object.keys(message))
        ).toEqual([
            // `messageId` is the one key the snapshot whitelist gained (context T1.3);
            // an EDIT still added nothing, which is what T3.6 pinned.
            ['role', 'content', 'messageId'],
            ['role', 'content', 'messageId'],
            ['role', 'content', 'messageId'],
            ['role', 'content', 'messageId']
        ]);
        expect(JSON.stringify(snapshot.agents.writer.messages)).not.toContain('included');

        // (3) A restart from that document serves the EDITED text with no plugin involved
        //     at all: an edit is canonical, not request-scoped. Re-saving is stable.
        const restoredSeen: HarnessStreamRequest[] = [];
        const target = harness({
            agents: {
                writer: agent({
                    model: 'merge/ds4-flash',
                    stream: scripted([answer('after restore')], restoredSeen)
                })
            },
            presets: false
        });
        target.restore(snapshot);
        expect(target.snapshot()).toEqual(snapshot);

        await target('again');

        expect(restoredSeen[restoredSeen.length - 1].messages).toEqual([
            { role: 'system', content: 'Write.' },
            { role: 'user', content: 'edited seed' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'settled' },
            { role: 'user', content: 'again' }
        ]);
    });
});

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
            // v2 is the records-engine shape (one collection map, one id counter),
            // so the unsupported-version probe now names v1 as the file from before the
            // collapse: R5 says nothing is in production, so a v1 snapshot is REFUSED by
            // the version gate rather than half-migrated into the new reader.
            snapshot.version = 1 as unknown as HarnessSnapshot['version'];
        }, /Snapshot version 1 is not supported; this harness reads version 2\./);
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
            snapshot.records.collections.tasks.items.push(clone(snapshot.records.collections.tasks.items[0]));
        }, /lists the same id twice; ids are unique\./);

        await restoreRejects((snapshot) => {
            // ONE counter for the whole store (F3): the largest id across every
            // collection here is 6 (location), so anything at or below it collides.
            snapshot.records.nextId = 1;
        }, /records state\.nextId must be greater than the largest id \(1\); received 1\./);
    });

    it('rejects unknown record fields', async () => {
        await restoreRejects((snapshot) => {
            (snapshot.records.collections.locations as unknown as Record<string, unknown>).extra = true;
        }, /records state\.collections\.locations has an unknown field "extra"\./);
    });

    // -----------------------------------------------------------------------
    // T1: the task store's persisted half changed shape, and BOTH directions have
    // to hold: an old file restores with documented defaults, and a field the
    // current schema does not describe is reported instead of dropped.
    // -----------------------------------------------------------------------

    // A pre-T1 `records.todos` block: no `rev` on any record, and no `storeRev` or
    // `changes` on the store. Snapshot version 1 did not change, so this is a real
    // file a live server has on disk.
    // A pre-T1 RECORD shape (no `rev`, no attribution) inside the v2 collection
    // block: the counter moved to the store, and the definition is the spec the entries
    // are validated against. Nothing is invented on the way in — `rev: 1`, `storeRev: 0`,
    // empty feed.
    const legacyTodos = {
        definition: TASKS_COLLECTION,
        items: [
            { id: '1', text: 'Legacy open', completed: false },
            { id: '2', text: 'Legacy done', completed: true }
        ],
        storeRev: 0,
        changes: []
    };

    it('restores a pre-T1 task store with the documented defaults', async () => {
        const valid = await seedSmall();
        const target = buildSession();
        const restored = clone(valid) as unknown as HarnessSnapshot;

        (restored.records as unknown as { collections: Record<string, unknown> }).collections.tasks = clone(legacyTodos);
        // ONE store-level counter (F3): the legacy block tops out at id 2, so the
        // counter has to be past it or the restore reports a collision.
        restored.records.nextId = 3 as (typeof restored.records)['nextId'];
        target.restore(restored);

        // `rev` is the revision a record was CREATED with, and an old file has no
        // history at all: storeRev 0, empty feed. Nothing is invented.
        expect(target.snapshot().records.collections.tasks).toEqual({
            definition: TASKS_COLLECTION,
            items: [
                taskItem('1', 'Legacy open'),
                taskItem('2', 'Legacy done', { completed: true })
            ],
            storeRev: 0,
            changes: []
        });

        // The next write is a normal guarded write from rev 1, so a resumed session
        // can use every T1 verb immediately — and the feed starts from zero.
        expect(
            await target.executeTool('tasks', {
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
            storeRev: 1,
            // R1/T1.1 — the resumed write patched exactly ONE record, so it also
            // answers with `entry`: a restored pre-T1 store behaves like any other.
            entry: taskItem('1', 'Legacy open', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO })
        });
    });

    it('re-saves a legacy task store in the current shape, without inventing history', async () => {
        const valid = await seedSmall();
        const target = buildSession();
        const restored = clone(valid) as unknown as HarnessSnapshot;

        (restored.records as unknown as { collections: Record<string, unknown> }).collections.tasks = clone(legacyTodos);
        // ONE store-level counter (F3): the legacy block tops out at id 2, so the
        // counter has to be past it or the restore reports a collision.
        restored.records.nextId = 3 as (typeof restored.records)['nextId'];
        target.restore(restored);

        const normalized = target.snapshot();

        // A restore that changes nothing observable must not invent events either:
        // snapshotting straight back is the same defaulted block, so a host that
        // saves on every notification cannot grow a feed out of a legacy file.
        expect(normalized.records.collections.tasks).toEqual({
            definition: TASKS_COLLECTION,
            items: [taskItem('1', 'Legacy open'), taskItem('2', 'Legacy done', { completed: true })],
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
            (snapshot.records.collections.tasks.items[0] as unknown as Record<string, unknown>).reve = 2;
        }, /records state\.collections\.tasks\.items\[0\] has an unknown field "reve"\./);

        await restoreRejects((snapshot) => {
            (snapshot.records.collections.tasks.items[0] as unknown as Record<string, unknown>).rev = 0;
        }, /records state.collections.tasks\.items\[0\]\.rev must be between 1 and Infinity\./);

        // Decision P deleted the lock, so a persisted claim field is not restored and
        // not cross-checked — it is refused as a key the shape does not describe. That is
        // the honest replacement for the old "leaseUntil needs owner" rule: an old file
        // cannot silently re-introduce a lock the engine no longer models.
        await restoreRejects((snapshot) => {
            (snapshot.records.collections.tasks.items[0] as unknown as Record<string, unknown>).leaseUntil =
                EPOCH_MS + 900_000;
        }, /items\[0\] has an unknown field "leaseUntil"\./);

        await restoreRejects((snapshot) => {
            (snapshot.records.collections.tasks.items[0] as unknown as Record<string, unknown>).leaseUntil = 'soon';
        }, /items\[0\] has an unknown field "leaseUntil"\./);

        // The feed itself: an unknown store key, an op the tool never logs, and a
        // log that does not rise.
        await restoreRejects((snapshot) => {
            (snapshot.records.collections.tasks as unknown as Record<string, unknown>).revision = 1;
        }, /records state.collections.tasks has an unknown field "revision"\./);

        await restoreRejects((snapshot) => {
            const todos = snapshot.records.collections.tasks as unknown as { changes: Record<string, unknown>[] };

            todos.changes[0].op = 'explode';
        }, /changes\[0\]\.op must be one of: add, update, remove\./);

        await restoreRejects((snapshot) => {
            const todos = snapshot.records.collections.tasks as unknown as {
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
        }, /records state\.collections\.tasks\.changes must be strictly ascending in "rev"; 1 follows 2\./);

        // A feed that runs ahead of the revision it was written under is the same
        // corruption in the other direction: every event is bounded by `storeRev`.
        await restoreRejects((snapshot) => {
            (snapshot.records.collections.tasks as unknown as Record<string, unknown>).storeRev = 0;
        }, /storeRev is 0, behind the last retained change \(1\)\./);

        // `fields` names content fields only, and never a field twice.
        await restoreRejects((snapshot) => {
            const todos = snapshot.records.collections.tasks as unknown as { changes: Record<string, unknown>[] };

            todos.changes[0].fields = ['owner'];
        }, /records state.collections.tasks\.changes\[0\]\.fields entries must be one of: text, completed\./);

        await restoreRejects((snapshot) => {
            const todos = snapshot.records.collections.tasks as unknown as { changes: Record<string, unknown>[] };

            todos.changes[0].fields = ['text', 'text'];
        }, /records state.collections.tasks\.changes\[0\]\.fields lists "text" more than once\./);

        await restoreRejects((snapshot) => {
            (snapshot.records.collections.tasks.items[0] as unknown as Record<string, unknown>).completed =
                'true';
        }, /records state\.collections\.tasks\.items\[0\] "completed" must be a boolean when provided\./);
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
                callTool('c1', 'tasks', '{"tasks":[{"text":"Persist me"}]}'),
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
            { type: 'state_change', reason: 'tool_execute', agent: 'writer', tool: 'tasks' },
            { type: 'state_change', reason: 'agent_message', agent: 'writer' }
        ]);

        events.length = 0;

        // Manual Tools-tab mutations emit no progress events, so this is the only
        // observation point.
        await writer.executeTool('profiles', {
            action: 'add',
            name: 'Elena',
            description: 'A cartographer.'
        });
        expect(events).toEqual([
            { type: 'state_change', reason: 'tool_execute', tool: 'profiles' }
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

        await writer.executeTool('tasks', { tasks: [{ text: 'Still here' }] });

        expect(await writer.executeTool('tasks', {})).toEqual({
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


});

// ---------------------------------------------------------------------------
// DISPLAY LANE (C1) — the per-conversation number the context bar stacks rows by.
//
// `contextLane` is OPTIONAL on a host thread and the writer never emits a 0: the
// plugin setter DELETES the key for 0 (./harness.ts `setThreadContextLane`) and the
// reader normalizes a written 0 away (./core/snapshot.ts `readThreads`), so a
// conversation that never compacted keeps its exact pre-lane document.
//
// These tests drive the READER with a hand-written lane, because the lane has no
// public setter on the harness facade: only a plugin host can raise one
// (./plugins/context-compaction.plugin.ts is the only producer in the product), and
// the write/live side of the same field is pinned in ./server/threads.test.ts. What
// is pinned here is what a host's `state.json` is allowed to say, plus the one
// inheritance rule of minting a thread (NOTE-6, the last test below).
// ---------------------------------------------------------------------------
describe('snapshot persistence of the display lane', () => {
    // A one-thread harness, so `snapshot().threads[0]` is the record the reader walks
    // (./core/snapshot.ts `readThreads` labels entries exactly that way).
    const laneSession = (): Harness => {
        const session = harness({
            agents: {
                writer: agent({ model: 'merge/ds4-flash', stream: scripted([answer('idle')]) })
            },
            primary: 'writer',
            presets: false
        });

        session.createThread('writer', { label: 'Lane' });

        return session;
    };

    // The persisted thread record, as the reader sees it.
    const threadOf = (snapshot: HarnessSnapshot): Record<string, unknown> =>
        snapshot.threads![0] as unknown as Record<string, unknown>;

    it('writes no lane key for a thread that never compacted, and restores the lane a host document carries', () => {
        const plain = clone(laneSession().snapshot());

        // Absence is the canonical shape: `snapshot()` emits no key while the lane is 0.
        expect(JSON.stringify(plain)).not.toContain('contextLane');

        const written = clone(plain);
        threadOf(written).contextLane = 2;

        const target = laneSession();
        target.restore(written);

        // The lane survives as a number on the record, and it is LIVE state rather
        // than inert bytes: the thread accessor the context-bar stamp reads sees it.
        expect(threadOf(target.snapshot()).contextLane).toBe(2);
        expect(target.thread(String(threadOf(written).id))?.contextLane).toBe(2);

        // Re-saving is lossless and stable, and a second restore of the same document
        // replaces rather than duplicates or re-normalizes.
        expect(target.snapshot()).toEqual(written);
        target.restore(written);
        expect(target.snapshot()).toEqual(written);
    });

    it('normalizes a hand-written `contextLane: 0` back to the omitted form', () => {
        const plain = clone(laneSession().snapshot());

        const zero = clone(plain);
        threadOf(zero).contextLane = 0;

        const target = laneSession();
        expect(() => target.restore(zero)).not.toThrow();

        // A lane of 0 is what absence already means, so the restored document is
        // byte-identical to one that never carried the key — a session that never
        // compacted cannot accumulate a lane field through save/restore cycles.
        expect(JSON.stringify(target.snapshot())).not.toContain('contextLane');
        expect(target.snapshot()).toEqual(plain);
        expect(target.thread(String(threadOf(plain).id))?.contextLane).toBeUndefined();
    });

    it('refuses a lane a renderer could not sort, and leaves the target untouched', () => {
        const plain = clone(laneSession().snapshot());

        // The reader is the shared `readSnapshotInteger` (./core/snapshot-validation.ts),
        // so a non-number and a fraction both fail its safe-integer check, and a
        // negative fails the bound — no lane is restored at all, which is what protects
        // a bar from an unsortable row rather than guessing a default.
        const rejections = [
            { value: 'one', message: 'snapshot.threads[0].contextLane must be a safe integer.' },
            { value: 1.5, message: 'snapshot.threads[0].contextLane must be a safe integer.' },
            { value: -1, message: 'snapshot.threads[0].contextLane must be between 0 and Infinity.' }
        ];

        for (const { value, message } of rejections) {
            const invalid = clone(plain);
            threadOf(invalid).contextLane = value;

            const target = laneSession();
            const before = target.snapshot();

            expect(() => target.restore(invalid)).toThrow(message);
            expect(target.snapshot()).toEqual(before);
        }
    });

    // NOTE-6 — the ONE inheritance decision this field has, pinned so a future edit cannot
    // flip it silently: a conversation minted by `createThread` starts at lane 0 EVEN WHEN it
    // is created from a conversation that already sits on a lane. `ownerThreadId` is an
    // OWNERSHIP link (scheduling, deletion, the resume path), while a lane is one
    // conversation's own compaction history — the two stacked rows a bump paints describe
    // what THAT conversation remembers, which a brand-new conversation does not have
    // (./harness.ts:5045-5051 leaves the key out of the fresh record on purpose). Ownership
    // travels, the lane does not, and every other record copy keeps the source's lane
    // (`threadRecordCopy` is a spread, ./harness.ts:4689; `restore()` re-creates the record
    // field-for-field, pinned above).
    it('mints a new conversation at lane 0 instead of inheriting its owner lane', () => {
        const plain = clone(laneSession().snapshot());

        // Lane 3 on the only host thread, hand-written the way the tests above do it (the
        // plugin setter is the product's only producer, so the reader is the seam here).
        threadOf(plain).contextLane = 3;

        const session = laneSession();
        session.restore(plain);

        const ownerId = String(threadOf(plain).id);

        // A RECORD COPY preserves the lane — both read paths the facade exposes return one
        // (`threads()` and `thread()` are both `threadRecordCopy` maps), which is what makes
        // the absence below a creation decision rather than a copy dropping a field.
        expect(session.thread(ownerId)?.contextLane).toBe(3);
        expect(session.threads().find((thread) => thread.id === ownerId)?.contextLane).toBe(3);

        // A delegation child OF the lanned conversation: the same creation call, one key
        // present and one absent.
        const child = session.createThread('writer', { label: 'Child', ownerThreadId: ownerId });

        expect(Object.hasOwn(child, 'contextLane')).toBe(false);
        expect(Object.hasOwn(session.thread(child.id) ?? {}, 'contextLane')).toBe(false);
        expect(child.ownerThreadId).toBe(ownerId);

        // The owner keeps its lane, so nothing moved on the conversation the child came from.
        expect(session.thread(ownerId)?.contextLane).toBe(3);

        // THE PERSISTED DOCUMENT says exactly that: one lane key, on one thread. Written the
        // way `snapshot()` writes it — the child's row keeps its pre-lane shape (no key, not
        // a `contextLane: 0`), which is what a never-compacted conversation always had.
        const saved = session.snapshot();
        const rows = saved.threads as unknown as Record<string, unknown>[];
        const ownerRow = rows.find((row) => row.id === ownerId);
        const childRow = rows.find((row) => row.id === child.id);

        expect(ownerRow?.contextLane).toBe(3);
        expect(childRow?.ownerThreadId).toBe(ownerId);
        expect(Object.hasOwn(childRow ?? {}, 'contextLane')).toBe(false);

        // The pair survives a second round trip unchanged: the lane stays on its own
        // conversation and never leaks onto the row created next to it.
        const again = laneSession();
        again.restore(saved);

        expect(again.snapshot()).toEqual(saved);
        expect(again.thread(child.id)?.contextLane).toBeUndefined();
        expect(again.thread(ownerId)?.contextLane).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// THE CONVERSATION'S TOOL SWITCHES (`discovery.withheld`).
//
// The session switch (../harness.ts `withheldTools`) is conversation state, and for the
// names that matter most it is the ONLY place that state exists: a `visibility: 'core'`
// declaration and the pending-only runtime controls never appear in `discovery.enabled`,
// so a restart that restored only `enabled` would hand back every control the user
// switched off. Pinned here:
//   - the key is OMITTED while empty, so every document this build wrote before the
//     feature — and every fixture above — keeps its exact shape, and `version` stays 2
//     (an additive optional key is a schema extension, not a break);
//   - restore validates it LENIENTLY: an unknown name is dropped, never thrown. The
//     `enabled` list above it stays strict on purpose (./server/restore-enabled-tool-prune
//     .test.ts documents what strictness costs a session), and a switch that refers to a
//     tool this build no longer registers asserts nothing dangerous, so it must not be
//     the reason a whole conversation fails to load.
// ---------------------------------------------------------------------------

describe('snapshot persistence of the conversation tool switches', () => {
    it('omits the key while nothing is switched off, and pins the schema version at 2', async () => {
        const writer = buildSession();

        // Absence, not an empty list: the document shape a v2 file always had.
        expect(writer.snapshot().discovery).toEqual({ enabled: [], offsets: [] });
        expect(Object.hasOwn(writer.snapshot().discovery, 'withheld')).toBe(false);
        expect(HARNESS_SNAPSHOT_VERSION).toBe(2);
    });

    it('round-trips a core switch and a searchable switch through JSON, and the next request obeys both', async () => {
        const source = buildSession();

        // Two shapes: `tasks` is a core declaration (no cap slot, so `enabled` says nothing
        // about it) and `bulk01` is a seeded searchable row that DOES hold one.
        await source.executeTool('toolRequest', { tags: ['bulk'] });
        const capBefore = source.discoveredTools;
        source.runtime.manageTool(undefined, { operation: 'disable', name: 'tasks' });
        source.runtime.manageTool(undefined, { operation: 'disable', name: 'bulk01' });

        // Sorted, so two writes of one state are byte-comparable, and the searchable name
        // left the capped set on the way out.
        expect(source.snapshot().discovery).toEqual({
            enabled: capBefore.filter((entry) => entry !== 'bulk01'),
            offsets: [],
            withheld: ['bulk01', 'tasks']
        });

        const seen: HarnessStreamRequest[] = [];
        const target = buildSession({ seen });
        target.restore(JSON.parse(JSON.stringify(source.snapshot())));

        expect(target.withheldTools).toEqual(['bulk01', 'tasks']);
        expect(target.discoveredTools).toEqual(capBefore.filter((entry) => entry !== 'bulk01'));

        // The restored conversation BEHAVES like the one that saved it: the core control the
        // user switched off is not declared, and the searchable name is neither declared nor
        // findable through discovery.
        await target('go');
        const declared = (seen[0].tools ?? []).map((entry) => entry.name);
        expect(declared).not.toContain('tasks');
        expect(declared).not.toContain('bulk01');
        expect((target.runtime.requestTools(undefined, { tags: ['bulk'] }) as Record<string, unknown>).enabled).not.toContain('bulk01');

        // Idempotent: restoring the same document again writes the same document back.
        const saved = source.snapshot();
        target.restore(saved);
        expect(target.snapshot().discovery).toEqual(saved.discovery);
    });

    it('drops a withheld name this harness does not register, and restores the rest of the document', async () => {
        const source = buildSession();
        source.runtime.manageTool(undefined, { operation: 'disable', name: 'tasks' });
        const saved = clone(source.snapshot());

        // The ordinary operational event this tolerance exists for: the tool was removed
        // from the harness between the save and the load (a key taken away, a plugin
        // unregistered, an app tool edited out of a card).
        const edited = clone(saved) as unknown as Record<string, any>;
        edited.discovery.withheld = ['ghost', 'tasks'];

        const target = buildSession();
        expect(() => target.restore(edited)).not.toThrow();
        expect(target.withheldTools).toEqual(['tasks']);

        // THE CONTRAST that keeps the asymmetry honest: the same unknown name in `enabled`
        // is still a contradiction and still throws, because that list CLAIMS a tool the
        // conversation can call.
        const strict = clone(saved) as unknown as Record<string, any>;
        strict.discovery.enabled = ['ghost'];
        expect(() => buildSession().restore(strict)).toThrow(
            'Snapshot discovery names "ghost", which is not registered in this harness.'
        );

        // A pre-feature document (no key at all) restores with NOTHING switched off.
        const legacy = clone(saved) as unknown as Record<string, any>;
        delete legacy.discovery.withheld;
        const reopened = buildSession();
        reopened.restore(legacy);
        expect(reopened.withheldTools).toEqual([]);
        expect(reopened.snapshot().discovery).toEqual({ enabled: [], offsets: [] });
    });

    it('resolves a name listed in BOTH discovery arrays as switched off, and refuses a malformed switch list', async () => {
        const source = buildSession();
        const saved = clone(source.snapshot());

        // A hand-edited or merged document can claim `bulk01` is enabled AND switched off.
        // The only coherent reading is the user's decision, and it has to survive the
        // restore — otherwise a stale `enabled` entry re-opens a switch on restart.
        const both = clone(saved) as unknown as Record<string, any>;
        both.discovery.enabled = ['bulk01'];
        both.discovery.withheld = ['bulk01'];

        const target = buildSession();
        target.restore(both);
        expect(target.discoveredTools).toEqual([]);
        expect(target.withheldTools).toEqual(['bulk01']);

        const rejects = (mutate: (discovery: Record<string, any>) => void, message: string): void => {
            const bad = clone(saved) as unknown as Record<string, any>;
            mutate(bad.discovery);
            expect(() => buildSession().restore(bad)).toThrow(message);
        };

        // SHAPE stays strict (only the registration check is lenient), and the closed key
        // list around it is unchanged: `withheld` joined it, nothing else may.
        rejects((discovery) => (discovery.withheld = 'tasks'), 'snapshot.discovery.withheld must be an array.');
        rejects((discovery) => (discovery.withheld = ['']), 'snapshot.discovery.withheld[0] must be at least 1 characters.');
        rejects(
            (discovery) => (discovery.switches = ['tasks']),
            'snapshot.discovery has an unknown field "switches".'
        );
    });
});
