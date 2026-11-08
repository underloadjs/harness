// task in the harness — declaration, turns, sharing, isolation, and names.
//
// These tests sit next to harness() because they pin harness integration, while
// src/core/task.test.ts covers the tool implementation itself:
//   - task is core and available on the very first request (no discovery);
//   - the list persists across harness calls and across agents in one harness;
//   - a mutation returns the CURRENT bounded list in the same round trip;
//   - a second harness (a second server session) starts empty;
//   - reset() clears the list with the conversation;
//   - configured tools, plugins, and toolCreate can still replace the name;
//   - invalid input becomes a readable, recoverable tool result;
//   - R9-R11: the demoted runtime rows (the record tools, the tool* inventory set,
//     threadFork) stay REGISTERED but are no longer DECLARED, so only
//     toolRequest + task are advertised up front.
//
// T1 (concurrency) is pinned HERE at the harness level, because the whole change
// exists for the multi-agent case and only the harness has two identities to
// interleave:
//   - every record carries `rev` + attribution, and every page carries `storeRev`;
//   - a call that has an agent identity may not patch or remove blind — it needs
//     the `expects` token it read (src/core/task.ts guarded writes);
//   - a concurrent edit rejects the WHOLE stale call atomically, leaves the store
//     AND the change feed untouched, and the caller succeeds after a re-read;
//   - `claim` blocks a foreign content write until it is released / taken over /
//     expired, and an ownership action never moves `rev`;
//   - `afterId` walks every record even when another agent removes one mid-walk;
//   - `since` returns the events a caller missed, with `changesHasMore` and
//     `changesTruncated` stated honestly.
//
// Expectations come from the approved wire design (one patch call, one bounded
// result `{ tasks, counts { total, completed, pending }, page, storeRev }` and the
// exact messages in src/core/task.ts), not from the implementation's output.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import { TASK_DEFAULT_LEASE_MS } from './core/task';
import type {
    Agent,
    Harness,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    TaskChange,
    TaskChangeOp,
    TaskItem,
    TaskParameters,
    TaskResult
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Clock policy
// ---------------------------------------------------------------------------
// THE FROZEN CLOCK. Every task-store timestamp (`updatedAt`, the change-feed `at`,
// a claim's `leaseUntil = Date.now() + leaseMs`) comes from Date in
// src/core/task.ts, so pinning Date gives each of them ONE exact expected value.
// `toFake: ['Date']` leaves setTimeout and the microtask queue REAL, which the
// scripted transports and the run loop here depend on (the same policy
// src/harness.thread-runtime.test.ts uses).
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);
const LEASE_UNTIL = EPOCH_MS + TASK_DEFAULT_LEASE_MS;
const LEASE_ISO = new Date(LEASE_UNTIL).toISOString();

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EPOCH_MS);
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Scripted transports
// ---------------------------------------------------------------------------

// Replay a scripted list of turns, one per request. `seen` records what the
// model was offered so the declaration tests can inspect it.
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

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): Agent =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

// A harness with no presets, so the registry is exactly the core tools plus
// whatever a test adds.
const quiet = (entry: Agent, tools: Record<string, any> = {}) =>
    harness({ agents: { writer: entry }, tools, presets: false });

// ---------------------------------------------------------------------------
// Exact-shape fixtures (src/core/task.ts)
// ---------------------------------------------------------------------------

// The ONE result shape: every success — read, add, patch, remove, claim — is the
// same bounded page, now with `storeRev` (one step per RECORDED event). `nextOffset`
// is omitted when `hasMore` is false, hence the explicit shape here.
const page = (offset = 0, limit = 20, hasMore = false) => ({ offset, limit, hasMore });

// The empty read, including the untouched store revision.
const empty = {
    tasks: [],
    counts: { total: 0, completed: 0, pending: 0 },
    page: page(),
    storeRev: 0
};

// One page of exactly these records with these counts.
const taskPage = (tasks: TaskItem[], total: number, completed: number, storeRev: number) => ({
    tasks,
    counts: { total, completed, pending: total - completed },
    page: page(),
    storeRev
});

type RecordShape = {
    completed?: boolean;
    rev?: number;
    // Attribution (who last WROTE) and ownership (who currently HOLDS) are separate
    // facts. A read never writes, so it never moves either.
    by?: string;
    threadId?: string;
    at?: string;
    owner?: string;
    ownerThreadId?: string;
    leaseUntil?: number;
};

// One stored record, in the exact key set `copyItem` emits (src/core/task.ts).
// `updatedThreadId` is ABSENT — not `undefined` — for an unthreaded caller, which is
// what `harness.executeTool` is: it hands the tool the primary agent and NO thread
// (src/harness.ts `executeToolInternal`), so `updatedBy` is set and the thread key
// simply does not exist.
const task = (id: string, text: string, shape: RecordShape = {}): TaskItem => ({
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

// One change-feed entry in the canonical key order (`rev, id, op, by, threadId, at,
// fields, itemRev`), with `by`/`threadId` present only when the caller had that
// identity.
const event = (
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

// A second agent object, so a test can hold TWO identities inside ONE harness.
// Identity is the (agent, thread) PAIR (src/core/task.ts `isHolder`), which is what
// makes "another agent changed it while I worked" expressible at all.
const secondBrain = (): Agent => brain(scripted([answer('unused')]), { name: 'researcher' });

// One caller identity for `harness.callTool`, the public door that carries a
// caller/thread pair exactly like a run does (src/harness.ts
// `invokeRegisteredTool`).
const asCaller = (who: Agent, threadId: string) => ({ agent: who, threadId });

const callAs = (
    writer: Harness,
    who: Agent,
    threadId: string,
    parameters: TaskParameters
): Promise<TaskResult> =>
    writer.callTool('task', parameters, asCaller(who, threadId)) as Promise<TaskResult>;

// The runtime rows R9-R11 demoted to demand discovery. They stay registered (so
// toolRequest can enable them) but must never appear in a declaration.
const DEMOTED_RUNTIME_TOOLS = [
    'toolRegistry',
    'toolCreate',
    'toolManage',
    'toolList',
    'profileManage',
    'chapterManage',
    'locationManage',
    'agentManage',
    'agentResult',
    'threadFork'
] as const;

describe('task', () => {
    it('is core and available on the first request without discovery', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted([callTool('c1', 'task', '{"tasks":[{"text":"Draft plan"}]}'), answer('added')], seen)
        );
        const writer = quiet(entry);

        expect(writer.tools.task.visibility).toBe('core');

        await writer('start a plan');

        // toolRequest is never called, yet task was declared and executed. R9-R11
        // leaves exactly the discovery bootstrap plus the session plan declared.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'task']);

        // The mutation answer IS the current list: no `{ todo, counts }` wrapper.
        // T1 adds the content revision, the attribution of THIS run (the primary
        // `writer` on its default conversation `agent:writer`), and `storeRev`.
        expect((entry.messages[2] as { content: string }).content).toBe(
            `{"tasks":[{"id":"1","text":"Draft plan","completed":false,"rev":1,"updatedBy":"writer","updatedThreadId":"agent:writer","updatedAt":"${EPOCH_ISO}"}],"counts":{"total":1,"completed":0,"pending":1},"page":{"offset":0,"limit":20,"hasMore":false},"storeRev":1}`
        );
    });

    it('keeps the list across harness calls and re-reads with no arguments', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'task', '{"tasks":[{"text":"Draft plan"}]}'),
                answer('added'),
                callTool('c2', 'task', '{}'),
                answer('listed')
            ])
        );
        const writer = quiet(entry);

        await writer('plan');
        await writer('status');

        const toolMessages = entry.messages.filter((message) => message.role === 'tool');

        // First call: the add already returned the list.
        expect(JSON.parse((toolMessages[0] as { content: string }).content)).toEqual(
            taskPage([task('1', 'Draft plan', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })], 1, 0, 1)
        );

        // Second call: an argument-less read of the same store, byte-identical. A
        // read is not a write, so the attribution and `storeRev` stay exactly where
        // the add left them.
        expect(JSON.parse((toolMessages[1] as { content: string }).content)).toEqual(
            taskPage([task('1', 'Draft plan', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })], 1, 0, 1)
        );
    });

    it('patches one field and removes by id, each time returning the list', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        await writer.executeTool('task', { tasks: [{ text: 'One' }, { text: 'Two' }] });

        // GUARDED WRITE. `executeTool` runs as the primary agent, so a patch of an
        // existing id must carry the token the caller READ (src/core/task.ts
        // guardedWriteMessage). The read first, then the write with that rev.
        const before = (await writer.executeTool('task', {})) as TaskResult;

        expect(before.tasks.map((item) => item.rev)).toEqual([1, 1]);

        // A partial patch leaves the untouched text in place, moves ONLY that
        // record's `rev`, and records exactly one store event.
        expect(
            await writer.executeTool('task', {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }]
            })
        ).toEqual(
            taskPage(
                [
                    task('1', 'One', { completed: true, rev: 2, by: 'writer', at: EPOCH_ISO }),
                    task('2', 'Two', { by: 'writer', at: EPOCH_ISO })
                ],
                2,
                1,
                3
            )
        );

        // Removals answer the same way, with the survivor list. A removal is a
        // guarded write too, so it needs the CURRENT token for the id it deletes.
        expect(
            await writer.executeTool('task', { remove: ['1'], expects: [{ id: '1', rev: 2 }] })
        ).toEqual(taskPage([task('2', 'Two', { by: 'writer', at: EPOCH_ISO })], 1, 0, 4));

        // A rejected patch does not move the store — not the records, not the id
        // counter, and not `storeRev`.
        await expect(writer.executeTool('task', { tasks: [{ id: '9', completed: true }] })).rejects.toThrow(
            'task has no task with id "9".'
        );
        expect(await writer.executeTool('task', {})).toEqual(
            taskPage([task('2', 'Two', { by: 'writer', at: EPOCH_ISO })], 1, 0, 4)
        );
    });

    it('shares one list with every agent in the same harness', async () => {
        const writerSeen: HarnessStreamRequest[] = [];
        const researcherSeen: HarnessStreamRequest[] = [];

        const researcher = brain(
            scripted(
                [callTool('r1', 'task', '{}'), answer('saw the shared list')],
                researcherSeen
            )
        );

        // A core sibling tool is enough to enter the researcher's run and prove
        // the same task instance serves both brains.
        const peek = tool({
            description: 'Ask the researcher what is planned.',
            tags: ['agents', 'inspect'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('researcher', 'list the plan')).content
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'task', '{"tasks":[{"text":"Shared item"}]}'),
                    callTool('c2', 'peek', '{}'),
                    answer('done')
                ],
                writerSeen
            )
        );

        const writer = harness({ agents: { writer: entry, researcher }, tools: { peek }, presets: false });
        await writer('plan and inspect');

        // The researcher's tool result is the primary's list, not an empty one.
        // The attribution names the WRITER (the primary that added it) even though
        // the reader is a different agent: identity is never a model argument.
        expect(JSON.parse((researcher.messages[2] as { content: string }).content)).toEqual(
            taskPage([task('1', 'Shared item', { by: 'writer', threadId: 'agent:writer', at: EPOCH_ISO })], 1, 0, 1)
        );

        // Both brains see task (and the bootstrap) as core; the primary additionally
        // sees delegate. `peek` was configured later than the baseline, so it follows.
        expect(declaredNames(writerSeen[0])).toEqual(['toolRequest', 'task', 'delegate', 'peek']);
        expect(declaredNames(researcherSeen[0])).toEqual(['toolRequest', 'task', 'peek']);
    });

    it('declares only toolRequest and task, and keeps the demoted rows discoverable', () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        // Registered (the harness can still run them, and toolRequest can surface
        // them) but searchable, which is exactly why they are not declared.
        for (const name of DEMOTED_RUNTIME_TOOLS) {
            expect(writer.tools[name], name).toBeDefined();
            expect(writer.tools[name].visibility, name).toBe('searchable');
        }

        // actionRequest is demoted too, but it only registers with an owner
        // answerer, so this harness has no row for it at all.
        expect(writer.tools.actionRequest).toBeUndefined();

        expect(Object.keys(writer.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'task',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel'
        ]);
    });

    it('isolates harnesses and clears on reset', async () => {
        const writerA = quiet(brain(scripted([answer('hi')])));
        const writerB = quiet(brain(scripted([answer('hi')])));

        // Separate factory instances per harness: not the same tool object.
        expect(writerA.tools.task).not.toBe(writerB.tools.task);

        // Session-bound core tools execute through the harness so they receive the
        // live reference and that harness's record store.
        await writerA.executeTool('task', { tasks: [{ text: 'Only A' }] });

        expect(await writerB.executeTool('task', {})).toEqual(empty);

        // A reset is a clean start, including the id sequence AND the store
        // revision (the change log is part of "start over").
        writerA.reset();

        expect(await writerA.executeTool('task', {})).toEqual(empty);
        expect(await writerA.executeTool('task', { tasks: [{ text: 'After reset' }] })).toEqual(
            taskPage([task('1', 'After reset', { by: 'writer', at: EPOCH_ISO })], 1, 0, 1)
        );
    });

    it('lets configured tools, plugins, and dynamic creation replace task', async () => {
        const custom = tool({ description: 'Mine.', tags: ['task'], execute: () => 'ok' });

        const configured = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            tools: { task: custom },
            presets: false
        });
        expect(configured.tools.task).not.toBe(custom);
        expect(configured.tools.task.description).toBe('Mine.');
        await expect(configured.executeTool('task', {})).resolves.toBe('ok');

        const plugin = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            plugins: [
                {
                    name: 'claim',
                    setup: (api) => {
                        api.addTool('task', {
                            description: 'Mine.',
                            tags: ['task'],
                            execute: () => 'plugin'
                        });
                    }
                }
            ]
        });
        await expect(plugin.executeTool('task', {})).resolves.toBe('plugin');

        const writer = quiet(brain(scripted([answer('hi')])));
        const creation = {
            description: 'Mine.',
            tags: ['task'],
            source: 'return 1;'
        };

        const created = writer.createTool({ ...creation, name: 'task' });
        expect(created.description).toBe('Mine.');
        await expect(writer.executeTool('task', {})).resolves.toBe(1);

        // The replaced row is still the same slot in the same registration order.
        expect(Object.keys(writer.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'task',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel'
        ]);
    });

    // THE MODEL DOOR. A rejected compare-and-swap is only useful if the agent that
    // made it can read the answer, so this pins the exact text the run records: the
    // tool's own message, wrapped as a failed tool result (src/harness.ts), plus the
    // successful retry from the token the SAME run just read back.
    it('turns a stale guarded write into a readable model result and recovers on retry', async () => {
        const entry = brain(
            scripted([
                // 1. The read that establishes the revision the model will believe.
                callTool('c1', 'task', '{}'),
                // 2. The write made with the token from BEFORE the host renamed the
                //    record, so the whole call is refused.
                callTool(
                    'c2',
                    'task',
                    '{"tasks":[{"id":"1","completed":true}],"expects":[{"id":"1","rev":1}]}'
                ),
                // 3. The same write with the revision the first result reported.
                callTool(
                    'c3',
                    'task',
                    '{"tasks":[{"id":"1","completed":true}],"expects":[{"id":"1","rev":2}]}'
                ),
                answer('recovered')
            ])
        );
        const writer = quiet(entry);

        // Seed the record, then move it through the host door so the model's token is
        // genuinely stale: `executeTool` is the unthreaded PRIMARY identity, so the
        // writer it attributes is the same agent name the run will carry.
        await writer.executeTool('task', { tasks: [{ text: 'Shared' }] });
        await writer.executeTool('task', {
            tasks: [{ id: '1', text: 'Renamed by the host' }],
            expects: [{ id: '1', rev: 1 }]
        });

        const message = await writer('work on the plan');

        expect(message.content).toBe('recovered');

        const results = entry.messages
            .filter((record) => record.role === 'tool')
            .map((record) => (record as { content: string }).content);

        // 1. The read: rev 2, and the host's attribution (no `updatedThreadId`,
        // because the host call had no conversation).
        expect(JSON.parse(results[0] as string)).toEqual(
            taskPage([task('1', 'Renamed by the host', { rev: 2, by: 'writer', at: EPOCH_ISO })], 1, 0, 2)
        );

        // 2. The refusal, word for word, exactly as the model receives it.
        expect(results[1]).toBe(
            'Tool "task" failed: task "1" changed since revision 1 (now 2, last edited by "writer"); re-read and retry; changed fields: text.'
        );

        // 3. The retry lands, and the host's text survives a `completed`-only patch.
        expect(JSON.parse(results[2] as string)).toEqual(
            taskPage(
                [
                    task('1', 'Renamed by the host', {
                        completed: true,
                        rev: 3,
                        by: 'writer',
                        threadId: 'agent:writer',
                        at: EPOCH_ISO
                    })
                ],
                1,
                1,
                3
            )
        );

        // Nothing was written by the refusal, so the successful retry is the store's
        // third and last event.
        const feed = (await writer.executeTool('task', { since: 0 })) as TaskResult & {
            changes: TaskChange[];
        };

        expect(feed.changes).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'update', { by: 'writer', fields: ['text'], itemRev: 2 }),
            event(3, '1', 'update', {
                by: 'writer',
                threadId: 'agent:writer',
                fields: ['completed'],
                itemRev: 3
            })
        ]);
    });

    it('turns invalid task input into a recoverable tool result', async () => {
        const entry = brain(
            scripted([callTool('c1', 'task', '{"tasks":[{"text":"   "}]}'), answer('recovered')])
        );
        const writer = quiet(entry);

        const message = await writer('try');

        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe(
            'Tool "task" failed: task "tasks[0]" requires a non-empty "text" string.'
        );
        expect(await writer.executeTool('task', {})).toEqual(empty);
    });
});

// ---------------------------------------------------------------------------
// T1 — the regression this whole change exists for: two writers, one store
// ---------------------------------------------------------------------------

describe('task concurrency across harness callers', () => {
    // A fresh two-identity harness with one seeded record. `writer` and
    // `researcher` are DIFFERENT agents of the same harness, so they share the one
    // store (the sharing itself is pinned above) and are distinguishable by the
    // (agent, thread) pair src/core/task.ts guards with.
    const seededHarness = async (): Promise<{
        writer: Harness;
        author: Agent;
        editor: Agent;
        read: () => Promise<TaskResult>;
    }> => {
        const author = brain(scripted([answer('unused')]));
        const editor = secondBrain();
        const writer = harness({ agents: { writer: author, researcher: editor }, presets: false });

        await writer.executeTool('task', { tasks: [{ text: 'Shared' }] });

        return {
            writer,
            author,
            editor,
            read: () => callAs(writer, author, 'thread-author', {})
        };
    };

    it('refuses a write that skipped its token, and names the token the caller needs', async () => {
        const { writer, author, editor } = await seededHarness();

        // A patch by an identified caller with NO `expects` is rejected before the
        // store is touched — the pre-T1 blind write is what lost concurrent work.
        await expect(
            callAs(writer, author, 'thread-author', { tasks: [{ id: '1', completed: true }] })
        ).rejects.toThrow('guarded write: pass expects [{ id, rev }] for task "1" (read it first).');

        await expect(callAs(writer, editor, 'thread-editor', { remove: ['1'] })).rejects.toThrow(
            'guarded write: pass expects [{ id, rev }] for task "1" (read it first).'
        );

        // Untouched: same record, same rev, same storeRev, and one log entry (the add).
        expect(await callAs(writer, editor, 'thread-editor', { since: 0 })).toEqual({
            tasks: [task('1', 'Shared', { by: 'writer', at: EPOCH_ISO })],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page(),
            storeRev: 1,
            changes: [event(1, '1', 'add', { by: 'writer', itemRev: 1 })],
            changesHasMore: false,
            changesTruncated: false
        });
    });

    it('rejects a stale concurrent patch atomically and succeeds after a re-read', async () => {
        const { writer, author, editor, read } = await seededHarness();

        // A reads the record: the token it holds is rev 1.
        const first = await read();

        expect(first.tasks).toEqual([task('1', 'Shared', { by: 'writer', at: EPOCH_ISO })]);
        expect(first.storeRev).toBe(1);

        // B renames the SAME id first, with the token it also read.
        const bWrote = await callAs(writer, editor, 'thread-editor', {
            tasks: [{ id: '1', text: 'Rewritten by the researcher' }],
            expects: [{ id: '1', rev: 1 }]
        });

        expect(bWrote.tasks).toEqual([
            task('1', 'Rewritten by the researcher', {
                rev: 2,
                by: 'researcher',
                threadId: 'thread-editor',
                at: EPOCH_ISO
            })
        ]);
        expect(bWrote.storeRev).toBe(2);

        // A now writes with the token it read BEFORE B. The WHOLE call is refused,
        // and the message states the current rev, the last editor, and — because the
        // change log covers the gap — the field that moved.
        await expect(
            callAs(writer, author, 'thread-author', {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }]
            })
        ).rejects.toThrow(
            'task "1" changed since revision 1 (now 2, last edited by "researcher"); re-read and retry; changed fields: text.'
        );

        // ATOMIC, both ways: the record still holds B's text with B's attribution,
        // and the change feed is exactly the two events that were already there. A
        // rejected call never logs, so a reader polling `since` sees no ghost.
        const afterRejection = await read();

        expect(afterRejection.tasks).toEqual([
            task('1', 'Rewritten by the researcher', {
                rev: 2,
                by: 'researcher',
                threadId: 'thread-editor',
                at: EPOCH_ISO
            })
        ]);
        expect(afterRejection.storeRev).toBe(2);
        expect(
            (
                (await callAs(writer, author, 'thread-author', { since: 0 })) as TaskResult & {
                    changes: TaskChange[];
                }
            ).changes
        ).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'update', {
                by: 'researcher',
                threadId: 'thread-editor',
                fields: ['text'],
                itemRev: 2
            })
        ]);

        // A re-reads and retries with the token it now holds: completed only, so B's
        // text survives — which is exactly the update the old last-write-wins store
        // silently dropped.
        const retry = await callAs(writer, author, 'thread-author', {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 2 }]
        });

        expect(retry).toEqual(
            taskPage(
                [
                    task('1', 'Rewritten by the researcher', {
                        completed: true,
                        rev: 3,
                        by: 'writer',
                        threadId: 'thread-author',
                        at: EPOCH_ISO
                    })
                ],
                1,
                1,
                3
            )
        );
    });

    it('refuses a token for a record another agent removed', async () => {
        const { writer, author, editor } = await seededHarness();

        await writer.executeTool('task', { tasks: [{ text: 'Second' }] });

        // B removes id "1" with the token it read.
        await callAs(writer, editor, 'thread-editor', { remove: ['1'], expects: [{ id: '1', rev: 1 }] });

        // A still believes id "1" exists at rev 1. The store names the removal it
        // actually hit (src/core/task.ts checks the tokens against the live store
        // first), so a stale token never masquerades as a CAS mismatch.
        await expect(
            callAs(writer, author, 'thread-author', {
                tasks: [{ id: '2', completed: true }],
                expects: [
                    { id: '1', rev: 1 },
                    { id: '2', rev: 1 }
                ]
            })
        ).rejects.toThrow('task "1" was removed since revision 1; re-read the list.');

        // THE SAME RACE, NAMED THE SAME WAY (T1 precedence fix). The token, not the
        // half of the call that spelled the id, is what proves which record is gone:
        // patching the gone id with its token gets the removed-since message, and so
        // does removing it. Only a call that sent NO token falls back to the plain
        // "no task with id" lookup (src/core/task.ts readPatch step 3 vs step 4).
        await expect(
            callAs(writer, author, 'thread-author', {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }]
            })
        ).rejects.toThrow('task "1" was removed since revision 1; re-read the list.');

        await expect(
            callAs(writer, author, 'thread-author', {
                remove: ['1'],
                expects: [{ id: '1', rev: 1 }]
            })
        ).rejects.toThrow('task "1" was removed since revision 1; re-read the list.');

        // Without the token the caller has proven nothing about id "1", so it is the
        // ordinary unknown-id rejection — and still not a guarded-write complaint.
        await expect(
            callAs(writer, author, 'thread-author', { tasks: [{ id: '1', completed: true }] })
        ).rejects.toThrow('task has no task with id "1".');

        // None of the four rejections changed anything: id "2" is still open at rev 1.
        expect((await callAs(writer, author, 'thread-author', {})).tasks).toEqual([
            task('2', 'Second', { by: 'writer', at: EPOCH_ISO })
        ]);
    });

    it('keeps a claim across agents: the holder writes, a foreign write is refused', async () => {
        const { writer, author, editor, read } = await seededHarness();

        // A claims the record for its own (agent, thread) pair with the default
        // lease. A claim is an OWNERSHIP event: `rev` stays 1 and only `storeRev`
        // moves, so nobody else's CAS token is invalidated by the claim itself. The
        // claim IS attributed (src/core/task.ts writeAttribution), which is how an
        // operator can tell who reserved it.
        const claimed = await callAs(writer, author, 'thread-author', { claim: ['1'] });

        expect(claimed.tasks).toEqual([
            task('1', 'Shared', {
                by: 'writer',
                threadId: 'thread-author',
                at: EPOCH_ISO,
                owner: 'writer',
                ownerThreadId: 'thread-author',
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(claimed.tasks[0].rev).toBe(1);
        expect(claimed.storeRev).toBe(2);

        // B's guarded patch is refused — with the token it would otherwise have had
        // — and the message names the holder and the exact expiry.
        await expect(
            callAs(writer, editor, 'thread-editor', {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }]
            })
        ).rejects.toThrow(
            `task "1" is claimed by "writer" until ${LEASE_ISO}; release it or take it over first.`
        );

        // The claim did not cost A anything: the record still reads rev 1, and the
        // only new event is the claim itself.
        const afterRefusal = await callAs(writer, editor, 'thread-editor', { since: 1 });

        expect(afterRefusal.tasks).toEqual([
            task('1', 'Shared', {
                by: 'writer',
                threadId: 'thread-author',
                at: EPOCH_ISO,
                owner: 'writer',
                ownerThreadId: 'thread-author',
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(afterRefusal.storeRev).toBe(2);
        expect(afterRefusal.changes).toEqual([
            event(2, '1', 'claim', { by: 'writer', threadId: 'thread-author' })
        ]);
        expect(afterRefusal.changesHasMore).toBe(false);
        expect(afterRefusal.changesTruncated).toBe(false);

        // The holder is never blocked by its own claim.
        const byHolder = await callAs(writer, author, 'thread-author', {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 1 }]
        });

        expect(byHolder.tasks).toEqual([
            task('1', 'Shared', {
                completed: true,
                rev: 2,
                by: 'writer',
                threadId: 'thread-author',
                at: EPOCH_ISO,
                owner: 'writer',
                ownerThreadId: 'thread-author',
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(byHolder.storeRev).toBe(3);

        // A releases: the ownership keys disappear entirely (not `undefined` keys),
        // `rev` is still untouched by the release, and the lift is logged so a
        // polling reader can see it.
        const released = await callAs(writer, author, 'thread-author', { release: ['1'] });

        expect(released.tasks).toEqual([
            task('1', 'Shared', {
                completed: true,
                rev: 2,
                by: 'writer',
                threadId: 'thread-author',
                at: EPOCH_ISO
            })
        ]);
        expect(released.storeRev).toBe(4);
        expect(
            (await callAs(writer, author, 'thread-author', { since: 3 })).changes
        ).toEqual([event(4, '1', 'release', { by: 'writer', threadId: 'thread-author' })]);

        // B is free now.
        const afterRelease = await callAs(writer, editor, 'thread-editor', {
            tasks: [{ id: '1', text: 'Finished by the researcher' }],
            expects: [{ id: '1', rev: 2 }]
        });

        expect(afterRelease.tasks).toEqual([
            task('1', 'Finished by the researcher', {
                completed: true,
                rev: 3,
                by: 'researcher',
                threadId: 'thread-editor',
                at: EPOCH_ISO
            })
        ]);
        expect(afterRelease.storeRev).toBe(5);
    });

    it('takes a live claim over, and an expired claim clears itself for the next writer', async () => {
        const { writer, author, editor, read } = await seededHarness();

        await callAs(writer, author, 'thread-author', { claim: ['1'] });

        // `takeover` is the deliberate override: B moves in while A's lease is live.
        const taken = await callAs(writer, editor, 'thread-editor', { takeover: ['1'] });

        expect(taken.tasks).toEqual([
            task('1', 'Shared', {
                by: 'researcher',
                threadId: 'thread-editor',
                at: EPOCH_ISO,
                owner: 'researcher',
                ownerThreadId: 'thread-editor',
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(taken.tasks[0].rev).toBe(1);
        // A takeover reads as a `claim` to everybody else: the holder changed.
        expect(taken.changes).toBeUndefined();
        expect((await read()).storeRev).toBe(3);

        // Past the lease, a FOREIGN writer is no longer refused — and the abandoned
        // claim is cleared and LOGGED before the update it unlocked
        // (src/core/task.ts plan.expired → clearClaim). A's (agent, thread) pair is
        // not the current holder, so A is that foreign writer here.
        vi.setSystemTime(EPOCH_MS + TASK_DEFAULT_LEASE_MS + 1_000);

        const afterExpiry = await callAs(writer, author, 'thread-author', {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 1 }]
        });
        const at = '2026-01-01T00:15:01.000Z';

        // No `owner`/`ownerThreadId`/`leaseUntil` keys survive: the clear deleted them.
        expect(afterExpiry.tasks).toEqual([
            task('1', 'Shared', { completed: true, rev: 2, by: 'writer', threadId: 'thread-author', at })
        ]);
        expect(afterExpiry.storeRev).toBe(5);
        expect(afterExpiry.changes).toBeUndefined();
        expect(
            (await callAs(writer, author, 'thread-author', { since: 3 })).changes
        ).toEqual([
            event(4, '1', 'release', { by: 'writer', threadId: 'thread-author', at }),
            event(5, '1', 'update', {
                by: 'writer',
                threadId: 'thread-author',
                at,
                fields: ['completed'],
                itemRev: 2
            })
        ]);
    });

    it('walks every record by afterId while another agent removes one mid-walk', async () => {
        const author = brain(scripted([answer('unused')]));
        const editor = secondBrain();
        const writer = harness({ agents: { writer: author, researcher: editor }, presets: false });

        await writer.executeTool('task', {
            tasks: Array.from({ length: 6 }, (_, index) => ({ text: `Step ${index + 1}` }))
        });

        const seen: string[] = [];
        const pages: TaskResult['page'][] = [];
        let afterId = '0';

        for (let guard = 0; guard < 8; guard += 1) {
            const result = await callAs(writer, author, 'thread-author', { afterId, limit: 2 });

            seen.push(...result.tasks.map((item) => item.id));
            pages.push(result.page);

            if (!result.page.hasMore) break;

            afterId = result.page.nextAfterId as string;

            // Drop one record the walk has ALREADY passed. Offset paging would then
            // slide every later record down a slot and skip one; the id cursor
            // cannot, because "everything above 2" is stable.
            if (guard === 0) {
                await callAs(writer, editor, 'thread-editor', { remove: ['2'], expects: [{ id: '2', rev: 1 }] });
            }
        }

        expect(seen).toEqual(['1', '2', '3', '4', '5', '6']);
        // Page 1: the two records, and the cursor to hand back.
        expect(pages[0]).toEqual({ offset: 0, limit: 2, hasMore: true, afterId: '0', nextAfterId: '2' });
        // Page 2 starts at the EFFECTIVE index of its first record (id "2" is gone,
        // so "3" is at index 1 of the ordered store), not at the offset the caller
        // would have computed.
        expect(pages[1]).toEqual({ offset: 1, limit: 2, hasMore: true, afterId: '2', nextAfterId: '4' });
        // The removal is visible everywhere: the last page carries ids 5 and 6,
        // reports no next cursor, and the counts are the SURVIVOR's five records.
        expect(pages[2]).toEqual({ offset: 3, limit: 2, hasMore: false, afterId: '4' });
        expect(pages).toHaveLength(3);

        const last = await callAs(writer, author, 'thread-author', { afterId: '6', limit: 2 });

        expect(last.tasks).toEqual([]);
        // An empty keyset page reports the ordered length as its effective offset.
        expect(last.page).toEqual({ offset: 5, limit: 2, hasMore: false, afterId: '6' });
        expect(last.counts).toEqual({ total: 5, completed: 0, pending: 5 });
        // Six additions, one removal: seven recorded events.
        expect(last.storeRev).toBe(7);
    });

    it('reports the missed events through since, including removals, and says when the feed is cut', async () => {
        const author = brain(scripted([answer('unused')]));
        const writer = quiet(author);

        // Four recorded events: add, update, claim, remove. Every content write
        // carries the token its caller read — `executeTool` is an identified caller.
        await writer.executeTool('task', { tasks: [{ text: 'One' }] });
        await writer.executeTool('task', {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 1 }]
        });
        await writer.executeTool('task', { claim: ['1'] });
        await writer.executeTool('task', { remove: ['1'], expects: [{ id: '1', rev: 2 }] });

        const feed = (await writer.executeTool('task', { since: 0 })) as TaskResult & {
            changes: TaskChange[];
        };

        expect(feed.changes).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'update', { by: 'writer', fields: ['completed'], itemRev: 2 }),
            event(3, '1', 'claim', { by: 'writer' }),
            event(4, '1', 'remove', { by: 'writer' })
        ]);
        expect(feed.changesHasMore).toBe(false);
        expect(feed.changesTruncated).toBe(false);
        expect(feed.storeRev).toBe(4);

        // A reader that already saw three of them gets exactly the fourth: the feed
        // is per-event, not a snapshot of the list.
        expect(((await writer.executeTool('task', { since: 3 })) as TaskResult).changes).toEqual([
            event(4, '1', 'remove', { by: 'writer' })
        ]);

        // Nothing new since the watermark the reader holds.
        const idle = (await writer.executeTool('task', { since: 4 })) as TaskResult & {
            changes: TaskChange[];
        };

        expect(idle.changes).toEqual([]);
        expect(idle.changesHasMore).toBe(false);
        expect(idle.changesTruncated).toBe(false);

        // A watermark ahead of the store is a bug, not an empty answer.
        await expect(writer.executeTool('task', { since: 5 })).rejects.toThrow(
            'task "since" is revision 5, ahead of the store (storeRev 4); read the list first.'
        );
    });

    it('caps the feed at 50 entries and flags both a longer feed and a trimmed window', async () => {
        const author = brain(scripted([answer('unused')]));
        const writer = quiet(author);

        // 200 additions (the record cap) is 200 events; one more event pushes the
        // window past TASK_MAX_CHANGES, so the oldest entry is dropped FIFO.
        await writer.executeTool('task', {
            tasks: Array.from({ length: 200 }, (_, index) => ({ text: `T${index + 1}` }))
        });
        expect(((await writer.executeTool('task', {})) as TaskResult).storeRev).toBe(200);

        // 51 entries are asked for at once: the feed is capped at 50 and says so.
        const capped = (await writer.executeTool('task', { since: 2 })) as TaskResult & {
            changes: TaskChange[];
        };

        expect(capped.changes.map((change) => change.rev)).toEqual(
            Array.from({ length: 50 }, (_, index) => index + 3)
        );
        expect(capped.changes[0]).toEqual(event(3, '3', 'add', { by: 'writer', itemRev: 1 }));
        expect(capped.changes[49]).toEqual(event(52, '52', 'add', { by: 'writer', itemRev: 1 }));
        expect(capped.changesHasMore).toBe(true);
        // Nothing has left the window yet, so the gap is a CAP, not a truncation.
        expect(capped.changesTruncated).toBe(false);

        // One more event overflows the 200-entry window, dropping rev 1.
        await writer.executeTool('task', {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 1 }]
        });
        const trimmed = (await writer.executeTool('task', { since: 0 })) as TaskResult & {
            changes: TaskChange[];
        };

        // The reader fell behind the oldest retained event, so the feed cannot be
        // complete: revs 2..51 of 201, capped at 50, flagged on both axes.
        expect(trimmed.changes[0]).toEqual(event(2, '2', 'add', { by: 'writer', itemRev: 1 }));
        expect(trimmed.changes).toHaveLength(50);
        expect(trimmed.changesHasMore).toBe(true);
        expect(trimmed.changesTruncated).toBe(true);
        expect(trimmed.storeRev).toBe(201);
    });
});
