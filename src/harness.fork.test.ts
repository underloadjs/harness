// N6 runtime: threadFork branches.
//
// Contract pinned here:
//   - threadFork is core (registered by default), forks the CALLING agent at the
//     request instant with its ENTIRE committed transcript, and returns ONLY
//     { branchId, threadId, content };
//   - a branch is a SEPARATE actor: two same-name forks run concurrently without
//     queuing behind the source or each other;
//   - normal forks nest up to forkDepth (2) independent of MAX_RUN_DEPTH, and the
//     branch inherits its source's primary/subagent role;
//   - every branch event carries kind + branchId on its thread, including nested
//     parentId links;
//   - a blank/non-substantive branch answer and a depth/concurrency refusal are
//     explicit tool errors;
//   - branch records are detached, bounded audit state and are excluded from
//     snapshot v1;
//   - the manual executeTool path refuses threadFork.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;
        for (const frame of frames) yield frame;
    };
};

// Route each request by its transcript. fork/agent share ONE transport, so a
// scripted list would consume frames in scheduler order; routing is deterministic.
const routed = (
    route: (request: HarnessStreamRequest) => HarnessStreamEvent[],
    seen?: HarnessStreamRequest[]
): HarnessStream =>
    async function* stream(request) {
        seen?.push(request);
        for (const frame of route(request)) yield frame;
    };

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const calls = (
    ...toolCalls: Array<{ id: string; name: string; arguments: string }>
): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls }
];

const call = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const latestUser = (request: HarnessStreamRequest): string => {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index];
        if (message.role === 'user') return message.content;
    }
    return '';
};

const toolMessages = (request: HarnessStreamRequest) =>
    request.messages.filter(
        (message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool'
    );

const toolContents = (request: HarnessStreamRequest): string[] =>
    toolMessages(request).map((message) => message.content);

const toolNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): Agent =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 32; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

const deferred = <T>() => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return { promise, resolve: settle };
};

const forkResult = (content: string) =>
    JSON.parse(content) as { branchId: string; threadId: string; content: string };

const ATTACHMENT = {
    id: 'a1',
    kind: 'image' as const,
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    // 12-byte PNG signature block; valid magic, tiny deterministic payload.
    size: 12,
    data: 'iVBORw0KGgoAAAAA'
};

describe('threadFork runtime', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs two same-name forks concurrently and returns only the branch summaries', async () => {
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const entry = brain(
            routed((request) => {
                const user = latestUser(request);
                if (user === 'task one') return answer('summary one');
                if (user === 'task two') return answer('summary two');

                const results = toolContents(request);
                if (results.some((content) => content.includes('summary one')) &&
                    results.some((content) => content.includes('summary two'))) {
                    return answer('root done');
                }

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        { id: 'f1', name: 'threadFork', arguments: '{"input":"task one"}' },
                        { id: 'f2', name: 'threadFork', arguments: '{"input":"task two"}' }
                    );
                }

                // A tool-free response while the forks are still running: the run
                // pauses, then the completions drive the next turn.
                return answer('waiting');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer('go');
        await flush();

        const records = writer.branches();
        expect(records).toHaveLength(2);
        expect(records.map((record) => record.status)).toEqual(['completed', 'completed']);
        expect(records.map((record) => record.kind)).toEqual(['fork', 'fork']);
        expect(records.map((record) => record.agent)).toEqual(['writer', 'writer']);
        expect(records[0].branchId).not.toBe(records[1].branchId);

        const results = entry.messages
            .filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool')
            .map((message) => forkResult(message.content));

        expect(results.map((result) => result.content)).toEqual(['summary one', 'summary two']);
        expect(results.map((result) => result.threadId)).toEqual([
            records[0].branchId,
            records[1].branchId
        ]);

        // The requester only ever received normal tool results between its turns.
        expect(entry.messages.filter((message) => message.role === 'user')).toHaveLength(1);
        expect(toolNames(seen[seen.length - 1])).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork'
        ]);

        // Every branch frame is labelled with its branch thread.
        const branchStarts = events.filter((event) => event.type === 'branch_start');
        expect(branchStarts).toHaveLength(2);
        const branchThreads = events
            .filter((event) => event.thread?.branchId !== undefined)
            .map((event) => `${event.type}:${event.thread?.kind}:${event.thread?.branchId}`);
        expect(branchThreads).toContain(`start:fork:${records[0].branchId}`);
        expect(branchThreads).toContain(`done:fork:${records[1].branchId}`);
    });

    it('nests normal forks up to forkDepth and refuses a deeper fork as a tool error', async () => {
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const entry = brain(
            routed((request) => {
                const user = latestUser(request);
                const results = toolContents(request);

                if (results.some((content) => content.includes('exceeds maxDepth'))) {
                    return answer('inner summary');
                }
                if (results.some((content) => content.includes('inner summary'))) {
                    return answer('outer summary');
                }
                if (results.some((content) => content.includes('outer summary'))) {
                    return answer('root done');
                }
                if (user === 'inner task') {
                    return call('deep', 'threadFork', '{"input":"too deep"}');
                }
                if (user === 'outer task') {
                    return call('inner', 'threadFork', '{"input":"inner task"}');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('outer', 'threadFork', '{"input":"outer task"}');
                }
                return answer('waiting');
            }, seen)
        );

        const writer = harness({
            agents: {
                writer: entry,
                helper: brain(scripted([answer('unused')]))
            },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer('go');
        await flush();

        const records = writer.branches();
        expect(records).toHaveLength(2);
        expect(records.map((record) => record.forkDepth)).toEqual([1, 2]);
        expect(records[1].sourceBranchId).toBe(records[0].branchId);
        expect(records.map((record) => record.status)).toEqual(['completed', 'completed']);

        // Role inheritance: a fork of the primary still sees agentDelegate.
        expect(records[0].role).toBe('primary');
        expect(records[0].tools).toContain('agentDelegate');
        expect(records[0].tools).toContain('threadFork');

        // The depth refusal is a normal error-shaped tool result on the inner
        // branch, never a third branch record.
        const depthError = records[1].messages.find(
            (message) =>
                message.role === 'tool' &&
                message.content.includes('exceeds maxDepth 2')
        );
        expect(depthError).toBeDefined();

        // Nested thread identity: the inner branch's parent is the outer branch.
        const innerStart = events.find(
            (event) =>
                event.type === 'start' &&
                event.thread?.branchId === records[1].branchId
        );
        expect(innerStart?.thread).toEqual({
            id: records[1].branchId,
            input: 'inner task',
            parentId: records[0].branchId,
            callId: 'inner',
            kind: 'fork',
            branchId: records[1].branchId
        });
    });

    it('copies the entire source transcript, model, attachments and declarations', async () => {
        const seen: HarnessStreamRequest[] = [];

        const entry = brain(
            routed((request) => {
                if (latestUser(request) === 'inspect') return answer('branch summary');
                if (toolContents(request).some((content) => content.includes('branch summary'))) {
                    return answer('root final');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"inspect"}');
                }
                return answer('waiting');
            }, seen),
            {
                model: 'copy/model',
                instruction: 'SYS',
                messages: [{ role: 'user', content: 'seed', attachments: [ATTACHMENT] }]
            }
        );

        const writer = harness({ agents: { writer: entry }, presets: false });
        await writer('root input');
        await flush();

        const branchRequest = seen.find((request) => latestUser(request) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(branchRequest?.model).toBe('copy/model');
        expect(branchRequest?.messages[0]).toEqual({ role: 'system', content: 'SYS' });
        expect(branchRequest?.messages[1]).toEqual({
            role: 'user',
            content: 'seed',
            attachments: [ATTACHMENT]
        });

        const remappedCall = branchRequest?.messages.find(
            (message) => message.role === 'assistant' && message.toolCalls !== undefined
        );
        expect(remappedCall?.role).toBe('assistant');
        expect((remappedCall as Extract<HarnessMessage, { role: 'assistant' }>).toolCalls).toEqual([
            {
                id: expect.stringMatching(/^call_branch-\d+_1$/),
                name: 'threadFork',
                arguments: '{"input":"inspect"}'
            }
        ]);
        const placeholder = branchRequest?.messages.find(
            (message) =>
                message.role === 'tool' &&
                message.content.startsWith('No tool result was committed before this branch was created')
        );
        expect(placeholder).toEqual({
            role: 'tool',
            content:
                'No tool result was committed before this branch was created (created-branch). This placeholder is NOT a successful result.',
            toolCallId: expect.stringMatching(/^call_branch-\d+_1$/),
            name: 'threadFork'
        });
        expect(toolNames(branchRequest)).toContain('threadFork');

        const record = writer.branches()[0];
        expect(record.model).toBe('copy/model');
        expect(record.messages[0]).toEqual({ role: 'system', content: 'SYS' });
        expect(record.messages[1]).toEqual({
            role: 'user',
            content: 'seed',
            attachments: [ATTACHMENT]
        });

        // The origin keeps only its own turns and the one normal tool result.
        expect(
            entry.messages
                .filter((message) => message.role === 'user')
                .map((message) => message.content)
        ).toEqual(['seed', 'root input']);

        // Detached audit copies: mutating one read never touches the record.
        record.messages.length = 0;
        expect(writer.branch(record.branchId)?.messages.length).toBeGreaterThan(0);
    });

    it('gives a subagent fork the subagent role, without agentDelegate or toolCreate', async () => {
        const seen: HarnessStreamRequest[] = [];

        const helper = brain(
            routed((request) => {
                if (latestUser(request) === 'probe') return answer('probe done');
                if (toolContents(request).some((content) => content.includes('probe done'))) {
                    return answer('helper done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"probe"}');
                }
                return answer('waiting');
            }, seen)
        );

        const lead = brain(
            routed((request) => {
                if (toolContents(request).some((content) => content.includes('helper done'))) {
                    return answer('lead done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('d1', 'agentDelegate', '{"agent":"helper","input":"go"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { lead, helper },
            primary: 'lead',
            subagents: ['helper'],
            presets: false,
            toolCreation: 'primary'
        });

        await writer('go');
        await flush();

        const record = writer.branches()[0];
        expect(record.role).toBe('subagent');
        expect(record.tools).not.toContain('agentDelegate');
        expect(record.tools).not.toContain('toolCreate');
        expect(record.status).toBe('completed');

        const branchRequest = seen.find((request) => latestUser(request) === 'probe');
        const names = toolNames(branchRequest);
        expect(names).not.toContain('agentDelegate');
        expect(names).not.toContain('toolCreate');
        expect(names).toContain('threadFork');
    });

    it('rejects a branch that answers with no substantive text', async () => {
        const entry = brain(
            routed((request) => {
                if (latestUser(request) === 'silent') return answer('   ');
                if (toolContents(request).some((content) => content.includes('no substantive answer'))) {
                    return answer('recovered');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"silent"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({ agents: { writer: entry }, presets: false });
        const message = await writer('go');
        await flush();

        expect(message.content).toBe('recovered');
        const toolResult = entry.messages.find(
            (entryMessage): entryMessage is Extract<HarnessMessage, { role: 'tool' }> =>
                entryMessage.role === 'tool'
        );
        expect(toolResult?.content).toContain('produced no substantive answer');
        expect(writer.branches()[0].status).toBe('failed');
    });

    it('refuses a fork that would re-enter the waiting original ancestor', async () => {
        const recall = tool({
            description: 'Run the writer again.',
            tags: ['cycle'],
            visibility: 'core',
            execute: ({ run }) => run!('writer', 'again')
        });

        const entry = brain(
            routed((request) => {
                const results = toolContents(request);
                if (results.some((content) => content.includes('already running'))) {
                    return answer('branch recovered');
                }
                if (results.some((content) => content.includes('branch recovered'))) {
                    return answer('root done');
                }
                if (latestUser(request) === 'cycle task') {
                    return call('r1', 'recall', '{}');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"cycle task"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({ agents: { writer: entry }, tools: { recall }, presets: false });
        await writer('go');
        await flush();

        const branch = writer.branches()[0];
        const toolResult = branch.messages.find(
            (entryMessage): entryMessage is Extract<HarnessMessage, { role: 'tool' }> =>
                entryMessage.role === 'tool' && entryMessage.name === 'recall'
        );
        expect(toolResult?.content).toContain('already running; it cannot be re-entered');
        expect(branch.status).toBe('completed');
    });

    it('cancel, failure and concurrency limits are explicit and bounded', async () => {
        // Concurrency 1: the second simultaneous fork is refused at launch.
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            routed((request) => {
                const results = toolContents(request);
                if (results.some((content) => content.includes('one summary'))) {
                    return answer('root done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return calls(
                        { id: 'f1', name: 'threadFork', arguments: '{"input":"one"}' },
                        { id: 'f2', name: 'threadFork', arguments: '{"input":"two"}' }
                    );
                }
                if (latestUser(request) === 'one') return answer('one summary');
                if (latestUser(request) === 'two') return answer('two summary');
                return answer('waiting');
            }, seen)
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            forks: { maxConcurrent: 1 }
        });

        await writer('go');
        await flush();

        const results = entry.messages.filter(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool'
        );
        expect(results).toHaveLength(2);
        expect(results.some((message) => message.content.includes('concurrent branch slots are in use'))).toBe(
            true
        );
        expect(writer.branches()).toHaveLength(1);
        expect(writer.branches()[0].status).toBe('completed');
    });

    it('marks a targeted cancellation and a branch failure as terminal audit states', async () => {
        const events: HarnessEvent[] = [];
        const never = new Promise<void>(() => undefined);

        const entry = brain(async function* stream(request) {
            if (latestUser(request) === 'slow') {
                // The branch never answers; the requester cancels the call.
                await never;
                yield* answer('late branch');
                return;
            }

            const results = toolContents(request);
            const realResults = results.filter((content) => !content.includes('"status":"pending"'));
            if (realResults.some((content) => content.includes('was cancelled before it completed'))) {
                yield* answer('after cancel');
                return;
            }
            if (realResults.some((content) => content.includes('provider exploded'))) {
                yield* answer('after failure');
                return;
            }
            if (!request.messages.some((message) => message.role === 'assistant')) {
                yield* call('f1', 'threadFork', '{"input":"slow"}');
                return;
            }
            if (realResults.length === 0) {
                yield* call('k1', 'toolCancel', '{"callId":"f1"}');
                return;
            }
            yield* answer('waiting');
        });

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer('go');
        await flush();

        const cancelled = writer.branches()[0];
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.error).toEqual({
            message: expect.stringContaining('aborted')
        });
        expect(
            events.filter(
                (event) =>
                    event.type === 'branch_end' &&
                    event.branchId === cancelled.branchId &&
                    event.status === 'cancelled'
            )
        ).toHaveLength(1);

        // Failure of a branch's transport is a normal error-shaped tool result.
        const failing = brain(
            routed((request) => {
                if (latestUser(request) === 'fail') throw new Error('provider exploded');
                const results = toolContents(request);
                if (results.some((content) => content.includes('provider exploded'))) {
                    return answer('after failure');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"fail"}');
                }
                return answer('waiting');
            })
        );

        const second = harness({ agents: { writer: failing }, presets: false });
        await second('go');
        await flush();

        const failedRecord = second.branches()[0];
        expect(failedRecord.status).toBe('failed');
        expect(failedRecord.error?.message).toContain('provider exploded');
        const failureResult = failing.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'threadFork'
        );
        expect(failureResult?.content).toContain('provider exploded');
    });

    it('never evicts active records and keeps only the newest terminal records', async () => {
        const gateOne = deferred<void>();
        const gateTwo = deferred<void>();

        const entry = brain(async function* stream(request) {
            const user = latestUser(request);
            const results = toolContents(request);

            if (user === 'one') {
                await gateOne.promise;
                yield* answer('one summary');
                return;
            }
            if (user === 'two') {
                await gateTwo.promise;
                yield* answer('two summary');
                return;
            }
            if (results.some((content) => content.includes('one summary')) &&
                results.some((content) => content.includes('two summary'))) {
                yield* answer('root done');
                return;
            }
            if (!request.messages.some((message) => message.role === 'assistant')) {
                yield* calls(
                    { id: 'f1', name: 'threadFork', arguments: '{"input":"one"}' },
                    { id: 'f2', name: 'threadFork', arguments: '{"input":"two"}' }
                );
                return;
            }
            yield* answer('waiting');
        });

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            forks: { maxBranchRecords: 1 }
        });

        const running = writer('go');
        await flush();

        // Both are running: an active record is never evicted for the budget.
        const active = writer.branches();
        expect(active).toHaveLength(2);
        expect(active.map((record) => record.status)).toEqual(['running', 'running']);

        gateOne.resolve();
        gateTwo.resolve();
        await running;
        await flush();

        const retained = writer.branches();
        expect(retained).toHaveLength(1);
        expect(retained[0].branchId).toBe(active[1].branchId);
        expect(retained[0].status).toBe('completed');
    });

    it('emits one cancelled branch_end when the run aborts during branch_start', async () => {
        const events: HarnessEvent[] = [];
        const controller = new AbortController();
        let aborted = false;

        const entry = brain(
            routed((request) => {
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"abort me"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                    // Abort the requester while its branch_start is being awaited:
                    // the scheduler then abandons the task before spec.run, so the
                    // branch task's catch never executes.
                    if (event.type === 'branch_start' && !aborted) {
                        aborted = true;
                        controller.abort(new Error('abort at branch start'));
                    }
                }
            }
        });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'abort at branch start'
        );
        await flush();

        const starts = events.filter((event) => event.type === 'branch_start');
        const ends = events.filter((event) => event.type === 'branch_end');

        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({
            type: 'branch_end',
            branchId: (starts[0] as Extract<HarnessEvent, { type: 'branch_start' }>).branch.branchId,
            status: 'cancelled',
            thread: { kind: 'fork', branchId: (starts[0] as Extract<HarnessEvent, { type: 'branch_start' }>).branch.branchId }
        });

        const record = writer.branches()[0];
        expect(record.status).toBe('cancelled');
        expect(record.error).toEqual({
            message:
                'The requesting run ended before this branch could start; the branch was cancelled.'
        });

        // A late task settlement (or any further cleanup) must not add a second end.
        await flush();
        expect(events.filter((event) => event.type === 'branch_end')).toHaveLength(1);
    });

    it('suppresses branch transcript persistence noise but keeps shared store notifications', async () => {
        const reasons: string[] = [];

        const entry = brain(
            routed((request) => {
                const results = toolContents(request);
                if (results.some((content) => content.includes('branch done'))) {
                    return answer('root done');
                }
                if (latestUser(request) === 'mutate') {
                    if (results.some((content) => content.includes('"todo"'))) {
                        return answer('branch done');
                    }
                    return call('t1', 'todoManage', '{"action":"add","text":"Shared item"}');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"mutate"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            report: {
                stateChange: (event) => {
                    reasons.push(`${event.reason}:${event.tool ?? ''}`);
                }
            }
        });

        await writer('go');
        await flush();

        // Root: user append, assistant fork call, fork tool result, final answer.
        // The branch's own appends (task, todo call, answer, result) are ephemeral
        // and must not ask a server to persist an agent_message.
        expect(reasons.filter((reason) => reason.startsWith('agent_message:'))).toHaveLength(4);

        // The branch shared the harness todo store, so its tool mutation is still
        // a persistence-worthy event.
        expect(reasons).toContain('tool_execute:todoManage');
        expect(await writer.executeTool('todoManage', { action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Shared item', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
    });

    it('exposes detached branch records, never snapshots them, and refuses manual execution', async () => {
        const entry = brain(
            routed((request) => {
                if (latestUser(request) === 'audit') return answer('audit answer');
                if (toolContents(request).some((content) => content.includes('audit answer'))) {
                    return answer('root done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"audit"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({ agents: { writer: entry }, presets: false });
        await writer('go');
        await flush();

        expect(writer.tools.threadFork).toBeDefined();
        expect(harness({ agents: { writer: entry }, presets: false, forks: { enabled: false } }).tools.threadFork).toBeUndefined();

        const record = writer.branch(writer.branches()[0].branchId);
        expect(record).toBeDefined();
        expect(record?.status).toBe('completed');
        expect(record?.result?.content).toBe('audit answer');

        const snapshot = writer.snapshot();
        expect((snapshot as unknown as { branches?: unknown }).branches).toBeUndefined();
        // The fork's own transcript is not snapshot state: the origin keeps only
        // its normal tool result, never the branch's user task or turns.
        expect(
            snapshot.agents.writer.messages
                .filter((message) => message.role === 'user')
                .map((message) => message.content)
        ).toEqual(['go']);

        await expect(writer.executeTool('threadFork', { input: 'manual' })).rejects.toThrow(
            'Tool "threadFork" is not available through executeTool: it requires the harness run that owns the conversation.'
        );

        expect(writer.branch('branch-missing')).toBeUndefined();
    });
});
