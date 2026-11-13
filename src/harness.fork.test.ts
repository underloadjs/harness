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
//
// Policy 2026-11-09 (docs/tasks/2026-11-09-thread-timeout-policy.md T5.3) adds the
// other half of one contract: a branch has NO wall-clock bound — it ends on its own
// answer, never on a clock. The whole file already owns the fake clock, so the test
// named for that task advances timers AND Date minutes past the 300000 ms a delegated
// child used to be given, with `vi.getTimerCount() === 0` proving nothing is armed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
// The branch placeholder text is asserted verbatim, so the constant is read from
// its own module (the same internal-import convention src/harness.snapshot.test.ts
// uses for `./core/task`), never retyped.
import { BRANCH_PENDING_PLACEHOLDER } from './core/branch';
import type {
    Agent,
    Harness,
    HarnessEvent,
    HarnessMessage,
    HarnessPluginApi,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
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

// The strict pairing invariant a forked transcript must keep (the R3 check of
// src/harness.background.test.ts `wireIssues`, restated here because that oracle
// lives inside its own test file and is not a package export): after every
// assistant message that requests tools there must be exactly one tool message
// per call, in call order, with no other role between, and no tool message may
// sit outside such a run.
const pairIssues = (messages: readonly HarnessMessage[]): string[] => {
    const issues: string[] = [];
    const claimed = new Set<number>();

    messages.forEach((message, index) => {
        if (message.role !== 'assistant') return;
        const requested = message.toolCalls ?? [];
        if (requested.length === 0) return;

        const expected = requested.map((entry) => entry.id);
        const actual: string[] = [];
        let cursor = index + 1;

        while (cursor < messages.length && messages[cursor].role === 'tool') {
            actual.push((messages[cursor] as Extract<HarnessMessage, { role: 'tool' }>).toolCallId);
            claimed.add(cursor);
            cursor += 1;
        }

        if (actual.join(',') !== expected.join(',')) {
            issues.push(
                `assistant#${index}: expected [${expected.join(',')}] but paired [${actual.join(',')}]`
            );
        }
    });

    messages.forEach((message, index) => {
        if (message.role !== 'tool' || claimed.has(index)) return;
        issues.push(
            `orphan tool#${index}: ${(message as Extract<HarnessMessage, { role: 'tool' }>).toolCallId}`
        );
    });

    return issues;
};

// The frozen instant the task-store tests below pin the (already faked) clock to, so
// every `updatedAt`/change-feed `at` has ONE exact expected ISO string. See
// src/core/task.ts, which stamps both from Date.
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);

const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 32; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// Move the fake clock by an exact amount and let the resulting work settle. Used by
// the 2026-11-09 "no wall-clock bound" policy test, where the point is that time
// passes and nothing acts on it.
const advanceBy = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
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
        // R9-R11: the requester's own declaration list is the bootstrap pair; the
        // fork grant adds the runtime controls without declaring them.
        expect(toolNames(seen[seen.length - 1])).toEqual(['toolRequest', 'tasks']);

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

        // Role inheritance: a fork of the primary still sees delegate.
        expect(records[0].role).toBe('primary');
        expect(records[0].tools).toContain('delegate');
        // R9-R11: threadFork is searchable, so it is no longer part of the declared
        // list. The branch still gets the runtime control itself.
        expect(records[0].tools).not.toContain('threadFork');

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
        // R9-R11: the branch copies the requester's declaration list, which is now
        // the bootstrap pair; threadFork is searchable and simply not in it.
        expect(toolNames(branchRequest)).toEqual(['toolRequest', 'tasks']);

        const record = writer.branches()[0];
        expect(record.model).toBe('copy/model');
        expect(withoutIds(record.messages[0])).toEqual({ role: 'system', content: 'SYS' });
        expect(withoutIds(record.messages[1])).toEqual({
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

    it('carries the context-inclusion flag into a branch transcript and keeps each disabled entry off the branch request', async () => {
        const seen: HarnessStreamRequest[] = [];

        const entry = brain(
            routed((request) => {
                if (latestUser(request) === 'inspect') return answer('branch summary');
                if (toolContents(request).some((content) => content.includes('branch summary'))) {
                    return answer('root final');
                }
                // The disabled seed unit is withheld, so this stays the first
                // request that contains an assistant turn.
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"inspect"}');
                }
                return answer('waiting');
            }, seen),
            {
                instruction: 'SYS',
                messages: [
                    { role: 'user', content: 'seed' },
                    { role: 'user', content: 'seed disabled', included: false },
                    {
                        role: 'assistant',
                        content: 'asked',
                        included: false,
                        toolCalls: [{ id: 'origin-a', name: 'tasks', arguments: '{}' }]
                    },
                    // The RESULT stays as the source wrote it: the unit widening is a
                    // projection rule, so a copy stays a faithful record.
                    { role: 'tool', content: 'ok', toolCallId: 'origin-a', name: 'tasks' }
                ]
            }
        );

        const writer = harness({ agents: { writer: entry }, presets: false });
        await writer('root input');
        await flush();

        const record = writer.branches()[0];
        const branchId = record.branchId;

        // (1) The branch record is the materialized source transcript plus the
        //     branch's own turns: every flag the source carried survived the copy,
        //     tool ids are remapped, and the unanswered threadFork call got the
        //     created-branch placeholder.
        expect(withoutIds(record.messages)).toEqual([
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'seed' },
            { role: 'user', content: 'seed disabled', included: false },
            {
                role: 'assistant',
                content: 'asked',
                included: false,
                toolCalls: [{ id: `call_${branchId}_1`, name: 'tasks', arguments: '{}' }]
            },
            { role: 'tool', content: 'ok', toolCallId: `call_${branchId}_1`, name: 'tasks' },
            { role: 'user', content: 'root input' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_2`, name: 'threadFork', arguments: '{"input":"inspect"}' }
                ]
            },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_2`,
                name: 'threadFork'
            },
            // The branch's own conversation, appended after the copied baseline.
            { role: 'user', content: 'inspect' },
            { role: 'assistant', content: 'branch summary' }
        ]);
        expect(JSON.stringify(record.messages)).not.toContain('"included":true');

        // (2) The branch's own provider request runs through the same projection, so the
        //     disabled standalone turn and the disabled REQUEST entry are absent — while the
        //     result that answers the switched-off call keeps riding, exactly as it does on the
        //     root side (R8: one flag, one entry). The surviving pending-call pair stays exact.
        const branchRequest = seen.find((request) => latestUser(request) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(branchRequest!.messages).toEqual([
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'seed' },
            {
                role: 'tool',
                content: 'ok',
                toolCallId: `call_${branchId}_1`,
                name: 'tasks'
            },
            { role: 'user', content: 'root input' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_2`, name: 'threadFork', arguments: '{"input":"inspect"}' }
                ]
            },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_2`,
                name: 'threadFork'
            },
            { role: 'user', content: 'inspect' }
        ]);
        // The one deliberate leak: a riding result with no owning block. It is the SAME shape
        // the root transcript's projection produces for the same flag, so a branch cannot be a
        // second, stricter projection.
        expect(pairIssues(branchRequest!.messages)).toEqual([`orphan tool#2: call_${branchId}_1`]);
        expect(JSON.stringify(branchRequest!.messages)).not.toContain('included');

        // (3) Forking never mutates the source: both disabled entries are still in
        //     the origin transcript, flagged, in their original positions.
        expect(withoutIds(entry.messages.filter((message) => message.role === 'user'))).toEqual([
            { role: 'user', content: 'seed' },
            { role: 'user', content: 'seed disabled', included: false },
            { role: 'user', content: 'root input' }
        ]);
    });

    // Context T1.4 — the BRANCH POLICY for transcript addresses. A fork COPIES them:
    // the branch's entry for a turn the owner already had is a different OBJECT with the
    // SAME id, which is what lets one `setIncluded(id, ...)` name the same turn on either
    // side. Ids are only ever scoped to one transcript (src/harness.ts `indexOfMessageId`),
    // so the numbers a branch mints for its OWN entries may repeat numbers the owner used
    // for different turns — that is the accepted consequence of the policy, and it is why
    // the API never claims a conversation-global id.
    it('copies transcript addresses into a branch, and numbers the branch\'s own entries itself', async () => {
        const seen: HarnessStreamRequest[] = [];

        const entry = brain(
            routed((request) => {
                if (latestUser(request) === 'inspect') return answer('branch summary');
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"inspect"}');
                }

                return answer('root final');
            }, seen),
            {
                instruction: 'SYS',
                messages: [
                    { role: 'user', content: 'seed' },
                    { role: 'user', content: 'seed disabled', included: false }
                ]
            }
        );

        const writer = harness({ agents: { writer: entry }, presets: false });
        await writer('root input');
        await flush();

        // The owner: instruction, two seeds, the prompt, the fork request, the fork
        // result, the final answer. Seven creations, seven addresses, in order.
        expect(entry.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3',
            'msg-4',
            'msg-5',
            'msg-6',
            'msg-7'
        ]);

        const record = writer.branches()[0];

        // (1) Copied, not re-minted — every entry the branch cloned from the owner still
        //     answers to the OWNER'S id, and none of them is the owner's object.
        expect(record.messages.slice(0, 5).map((message) => message.messageId)).toEqual(
            entry.messages.slice(0, 5).map((message) => message.messageId)
        );
        expect(record.messages.slice(0, 5)).not.toBe(entry.messages.slice(0, 5));
        for (let index = 0; index < 5; index += 1) {
            expect(record.messages[index]).not.toBe(entry.messages[index]);
        }

        // (2) The branch's own numbering starts above what it cloned. The pending
        //     placeholder for the unanswered `threadFork` call is materialized without an
        //     id (core/branch.ts `flushPending`) and is minted one when the branch seeds
        //     its baseline, and the branch's prompt and answer follow it — so `msg-6`
        //     names the owner's fork RESULT and the branch's PLACEHOLDER, each inside
        //     its own transcript.
        expect(record.messages.map((message) => message.messageId)).toEqual([
            'msg-1',
            'msg-2',
            'msg-3',
            'msg-4',
            'msg-5',
            'msg-6',
            'msg-7',
            'msg-8'
        ]);
        expect(record.messages[2]).toStrictEqual({
            role: 'user',
            content: 'seed disabled',
            included: false,
            messageId: 'msg-3'
        });

        // (3) Neither key reaches the branch's provider request: the projection strips
        //     the flag and the address together (core/agent.ts `withIncluded`).
        const branchRequest = seen.find((request) => latestUser(request) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(JSON.stringify(branchRequest!.messages)).not.toContain('messageId');
        expect(JSON.stringify(branchRequest!.messages)).not.toContain('included');
    });

    // Pipeline T3 — an ENTRY EDIT is canonical text, so the copy a fork is built from
    // carries it. `copyMessage` (src/core/branch.ts) whitelists `content` per role and
    // an edit introduces no new key, so nothing had to be added to that whitelist for
    // this to hold — the persistence rule T3.6 states, pinned here rather than asserted
    // in a comment.
    it('carries an edited entry into the branch transcript and the branch request', async () => {
        const seen: HarnessStreamRequest[] = [];

        const entry = brain(
            routed((request) => {
                if (latestUser(request) === 'inspect') return answer('branch summary');
                if (toolContents(request).some((content) => content.includes('branch summary'))) {
                    return answer('root final');
                }

                // Nothing is disabled in this fixture, so the copied assistant turn is
                // already in the FIRST request: the fork must be keyed on whether the
                // threadFork RESULT exists yet, not on whether an assistant turn does.
                const forked = request.messages.some(
                    (message) => message.role === 'tool' && message.name === 'threadFork'
                );
                if (!forked) return call('f1', 'threadFork', '{"input":"inspect"}');

                return answer('waiting');
            }, seen),
            {
                instruction: 'SYS',
                messages: [
                    { role: 'user', content: 'seed' },
                    {
                        role: 'assistant',
                        content: 'asked',
                        toolCalls: [{ id: 'origin-a', name: 'tasks', arguments: '{}' }]
                    },
                    { role: 'tool', content: 'ok', toolCallId: 'origin-a', name: 'tasks' }
                ]
            }
        );

        // One host plugin re-words the seeded turn through the REAL control surface. The
        // `find` guard makes it a one-shot write: once the text is edited no entry still
        // matches, so no later round (root or branch) writes again.
        const writer = harness({
            agents: { writer: entry },
            presets: false,
            plugins: [
                {
                    name: 'seed-editor',
                    setup: (api: HarnessPluginApi) => {
                        api.on('turn.before', (context) => {
                            const target = context.entries.find(
                                (candidate) => candidate.message.content === 'seed'
                            );

                            if (target === undefined) return;

                            context.edit(target, { content: 'seed, edited' });
                        });
                    }
                }
            ]
        });

        await writer('root input');
        await flush();

        // (1) Canonical source: the edited text is there ONCE, and the old text is gone.
        expect(entry.messages.filter((message) => message.content === 'seed, edited')).toHaveLength(1);
        expect(entry.messages.some((message) => message.content === 'seed')).toBe(false);

        // (2) The branch record is a materialization of the transcript AS IT IS NOW, so
        //     the copied baseline carries the edit at the same position.
        const record = writer.branches()[0];
        expect(withoutIds(record.messages[1])).toStrictEqual({ role: 'user', content: 'seed, edited' });

        // (3) The branch's own request was projected from that copy — edited text,
        //     remapped call ids, and a pair that is still complete.
        const branchRequest = seen.find((request) => latestUser(request) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(branchRequest!.messages.slice(0, 4)).toEqual([
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'seed, edited' },
            {
                role: 'assistant',
                content: 'asked',
                toolCalls: [{ id: `call_${record.branchId}_1`, name: 'tasks', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'ok',
                toolCallId: `call_${record.branchId}_1`,
                name: 'tasks'
            }
        ]);
        expect(pairIssues(branchRequest!.messages)).toEqual([]);
        expect(JSON.stringify(branchRequest!.messages)).not.toContain('included');
    });

    it('gives a subagent fork the subagent role, without delegate or toolCreate', async () => {
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
                    return call('d1', 'delegate', '{"agent":"helper","input":"go"}');
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
        expect(record.tools).not.toContain('delegate');
        expect(record.tools).not.toContain('toolCreate');
        expect(record.status).toBe('completed');

        const branchRequest = seen.find((request) => latestUser(request) === 'probe');
        const names = toolNames(branchRequest);
        expect(names).not.toContain('delegate');
        expect(names).not.toContain('toolCreate');
        // R9-R11: threadFork is searchable for every role, so a subagent fork's
        // declarations are exactly the bootstrap pair.
        expect(names).toEqual(['toolRequest', 'tasks']);
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
        // R1: one attempt — a branch failure is what is pinned here, not the retry
        // sequence (which would otherwise wait out the real backoff).
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
            }),
            { retry: false }
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
        // THE FROZEN CLOCK. `vi.useFakeTimers()` (beforeEach) freezes Date at the
        // wall-clock instant the file installed it, which is NOT a fixed value, so
        // the task store's T1 stamps (`updatedAt`, and the change-feed `at`) would
        // be unassertable. Pinning the system time gives every write in this test
        // ONE exact ISO string; a branch runs on the writer's default conversation,
        // so attribution is `writer` + `agent:writer` (src/core/task.ts reads both
        // from the ToolContext, never from the arguments).
        vi.setSystemTime(EPOCH_MS);

        const reasons: string[] = [];

        const entry = brain(
            routed((request) => {
                const results = toolContents(request);
                if (results.some((content) => content.includes('branch done'))) {
                    return answer('root done');
                }
                if (latestUser(request) === 'mutate') {
                    // The branch's own task page comes back with the `tasks` key, so
                    // that is the marker for "the mutation already happened".
                    if (results.some((content) => content.includes('"tasks"'))) {
                        return answer('branch done');
                    }
                    return call('t1', 'tasks', '{"tasks":[{"text":"Shared item"}]}');
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
        expect(reasons).toContain('tool_execute:tasks');
        expect(await writer.executeTool('tasks', {})).toEqual({
            tasks: [
                {
                    id: '1',
                    text: 'Shared item',
                    completed: false,
                    rev: 1,
                    updatedBy: 'writer',
                    updatedThreadId: 'agent:writer',
                    updatedAt: EPOCH_ISO
                }
            ],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
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

    // -------------------------------------------------------------------------
    // Policy doc T5.3 (2026-11-09) — a branch has no wall-clock bound.
    //
    // `docs/tasks/2026-11-09-thread-timeout-policy.md` F2 claims every
    // thread-running path except `delegate` already runs without a timer, and names
    // the fork layer as the cleanest confirmation (its four frozen bounds are COUNT,
    // DEPTH and SIZE only — MAX_FORK_DEPTH / MAX_FORK_CONCURRENT /
    // MAX_FORK_HISTORY_BYTES / MAX_BRANCH_RECORDS in src/core/branch.ts). This is the
    // regression guard for that claim: the whole file already owns the fake clock, so
    // an advanced clock here moves BOTH timers and Date, which rules out a timer-shaped
    // bound AND a deadline check. The host-thread half of the same requirement is in
    // src/harness.thread-runtime.test.ts.
    //
    // `async-ping` is replaced (the documented override path) so the ONLY thing that
    // could end the branch would be a turn bound, and `vi.getTimerCount()` proves
    // nothing is armed while it is parked.
    // -------------------------------------------------------------------------
    it('runs a branch with no clock when its own tool is parked (policy 2026-11-09 T5.3)', async () => {
        const events: HarnessEvent[] = [];
        const parked = deferred<string>();

        const entry = brain(
            routed((request) => {
                const results = toolContents(request);

                // The branch, after its parked tool settled.
                if (results.some((content) => content.includes('B-parked'))) return answer('branch done');
                // The origin, once the branch answer crossed back as its tool result.
                if (results.some((content) => content.includes('branch done'))) return answer('root done');
                // The branch's inspecting turn while the call is still parked: it must
                // NOT re-issue the call, so the assistant turn carrying it is the key.
                if (
                    request.messages.some(
                        (message) =>
                            message.role === 'assistant' &&
                            (message.toolCalls ?? []).some((entry) => entry.name === 'hold')
                    )
                ) {
                    return answer('waiting');
                }
                // The branch's first turn: park on a tool of its own.
                if (latestUser(request) === 'park') return call('h1', 'hold', '{}');
                // The origin's first turn.
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('f1', 'threadFork', '{"input":"park"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { writer: entry },
            tools: {
                hold: tool({
                    description: 'Park until released.',
                    tags: ['test'],
                    visibility: 'core',
                    mode: 'async',
                    execute: () => parked.promise
                })
            },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }],
            report: { progress: (event) => void events.push(event) }
        });

        const state: { status: 'pending' | 'resolved' | 'rejected'; value?: { content: string } } = {
            status: 'pending'
        };
        writer('go').then(
            (value) => {
                state.status = 'resolved';
                state.value = value;
            },
            (error) => {
                state.status = 'rejected';
                state.error = error;
            }
        );
        await flush();

        const starts = () => events.filter((event) => event.type === 'branch_start');
        const ends = () => events.filter((event) => event.type === 'branch_end');

        // The branch is running with one parked call, and nothing is armed.
        expect(starts()).toHaveLength(1);
        expect(ends()).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        // Well past the 300000 ms a delegated child used to be given, on a clock this
        // file owns completely.
        await advanceBy(300_001);
        expect(ends()).toHaveLength(0);
        expect(state.status).toBe('pending');
        expect(vi.getTimerCount()).toBe(0);

        await advanceBy(1_500_000);
        expect(ends()).toHaveLength(0);
        expect(state.status).toBe('pending');

        // It ends because its OWN answer arrived, with no error and no cancellation.
        parked.resolve('B-parked');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('root done');
        expect(ends()).toHaveLength(1);

        const record = writer.branch(writer.branches()[0].branchId);
        expect(record?.status).toBe('completed');
        expect(record?.result?.content).toBe('branch done');
        expect(record?.error).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
//
// BRANCH ADDRESSABILITY AND THE BRANCH'S OWN CLOCK (finding B1, 2026-11-13).
//
// `threadFork` answers with `{ branchId, threadId, content }`, both ids the SAME
// generated `branch-N`, and the branch is recorded as the invocation of that id. So the
// id is a HANDLE. This block pins the three things that used to be missing: the read
// seams answer that id (`thread()`, `threadMessages()`, and `threadRead` from inside the
// requester's lineage), a caller can BOUND the branch (`timeoutMs` on the call, or
// `threadForkTimeoutMs` on the harness for every door that names no bound), and the
// message that reaches the requester when a branch ends early carries the branch id that
// still addresses the work.
//
// The counterpart of the clock is its ABSENCE by default, already pinned by the policy
// test above (`vi.getTimerCount()` stays 0 and time passing changes nothing); the last
// test below re-pins it for the configured-option path, where a regression would actually
// live.
describe('threadFork branch addressability and its opt-in clock (B1)', () => {
    // This block owns the clock: `vi.getTimerCount()` is the assertion that a branch bound
    // exists (or does not), and `advanceBy` is what fires it.
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // One requester conversation plus one sibling that never took part in the fork: the pair
    // the visibility rule needs and the pair the roster check needs. `async-ping` is replaced
    // (the documented override path) so the heartbeat's interval timer stays out of the timer
    // count and the only timer a bounded branch arms is its own clock.
    const fixture = (stream: HarnessStream, extra: Record<string, unknown> = {}) => {
        const writer = harness({
            agents: { writer: brain(stream) },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }],
            ...extra
        });
        const home = writer.createThread('writer', { label: 'Home' });
        const sibling = writer.createThread('writer', { label: 'Sibling' });

        return { writer, home, sibling };
    };

    // A THREAD RUN needs the timer pump to move: `sendThreadInput` settles through timers,
    // and under fake timers settling takes passes rather than microtasks. So a test starts the
    // turn, pumps until its own bookkeeping says the run is done, then awaits the promise —
    // the shape `src/harness.thread-runtime.test.ts` uses for the same reason.
    const runThread = (writer: Harness, threadId: string, input: string) => {
        const state: { settled: boolean; content?: string; failure?: string } = {
            settled: false
        };
        const turn = writer.sendThreadInput(threadId, input).then(
            (message) => {
                state.settled = true;
                state.content = message.content;
                return message;
            },
            (error: Error) => {
                state.settled = true;
                state.failure = error.message;
                throw error;
            }
        );

        const pump = async (predicate: () => boolean, passes = 64): Promise<void> => {
            for (let pass = 0; pass < passes && !predicate(); pass += 1) await flush();
        };

        return { state, turn, pump };
    };

    // A branch that starts work and parks inside a tool call of its own, so whatever ends it
    // is the clock, a cancellation, or the release — never its own answer.
    const parkedBranch: HarnessStreamEvent[] = [
        { type: 'text', delta: 'started the work' },
        {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'h1', name: 'hold', arguments: '{}' }]
        }
    ];

    const holdTool = (promise: Promise<string>) => ({
        hold: tool({
            description: 'Park until released.',
            tags: ['test'],
            visibility: 'core',
            execute: () => promise
        })
    });

    // The route every fixture below shares, told apart by TRANSCRIPT rather than by turn
    // index (one transport serves the origin and its branch). Order matters: the settled
    // results first, then the "my own call is still parked, do not re-issue it" guard, then
    // the first turns. `pending` is filtered out of the origin's view because an async fork
    // leaves a pending placeholder behind while the branch works.
    const route = (rules: {
        branchSettled?: string;
        branchAnswer: string;
        rootAnswer: string;
        forkArguments: string;
        cancel?: boolean;
    }): HarnessStream =>
        routed((request) => {
            const results = toolContents(request);
            const realResults = results.filter((content) => !content.includes('"status":"pending"'));

            // The branch, after its parked tool settled (its release text, or its own answer).
            if (rules.branchSettled !== undefined && results.some((c) => c.includes(rules.branchSettled!))) {
                return answer(rules.branchAnswer);
            }

            // The origin, once a REAL result crossed back (a fork receipt, a cancellation, a
            // refusal) and the model has something to say about it.
            if (realResults.some((content) => content.includes(rules.rootAnswer))) {
                return answer(`${rules.rootAnswer}:done`);
            }

            // The branch's turn while its own call is still parked: re-issuing it would reuse
            // a committed tool-call id, which is a hard harness error.
            if (
                request.messages.some(
                    (message) =>
                        message.role === 'assistant' &&
                        (message.toolCalls ?? []).some((entry) => entry.name === 'hold')
                )
            ) {
                return answer('waiting');
            }

            // The branch's first turn: park on a tool of its own.
            if (latestUser(request) === 'inspect') return parkedBranch;

            // The origin's first turn: ask for the fork.
            if (!request.messages.some((message) => message.role === 'assistant')) {
                return call('f1', 'threadFork', rules.forkArguments);
            }

            // The origin, with the fork still in flight: cancel it, or simply pause and let
            // the completion drive the next turn.
            if (rules.cancel === true && realResults.length === 0) {
                if (
                    request.messages.some(
                        (message) =>
                            message.role === 'assistant' &&
                            (message.toolCalls ?? []).some((entry) => entry.name === 'toolCancel')
                    )
                ) {
                    return answer('waiting');
                }

                return call('k1', 'toolCancel', '{"callId":"f1"}');
            }

            return answer('waiting');
        });

    // The tool deliveries one thread's transcript recorded, in order.
    const toolResultsOf = (writer: Harness, threadId: string): string[] =>
        writer
            .threadMessages(threadId)
            .filter((entry): entry is Extract<HarnessMessage, { role: 'tool' }> => entry.role === 'tool')
            .map((entry) => entry.content);

    // The fork-call deliveries the requester's own transcript recorded, in order.
    const forkDeliveries = (writer: Harness, threadId: string): string[] =>
        writer
            .threadMessages(threadId)
            .filter(
                (entry): entry is Extract<HarnessMessage, { role: 'tool' }> =>
                    entry.role === 'tool' && entry.name === 'threadFork'
            )
            .map((entry) => entry.content);

    it('answers thread(), threadMessages() and a lineage threadRead() by the branch id', async () => {
        // The branch id only exists after the first run, and the SECOND conversation asks for
        // it by name, so the route reads it from a mutable cell — the convention
        // `src/plugin/context-compaction.test.ts` uses for an id it cannot know at build time.
        let branchAddress = '';

        const stream = routed((request) => {
            const user = latestUser(request);

            // The sibling's own turn: one `threadRead` of the branch it was never part of.
            if (user === 'read the branch') {
                if (toolContents(request).some((content) => content.includes('is not visible to thread'))) {
                    return answer('sibling heard the refusal');
                }

                return call('r1', 'threadRead', JSON.stringify({ thread: branchAddress }));
            }

            if (user === 'inspect') return answer('branch summary');

            if (toolContents(request).some((content) => content.includes('branch summary'))) {
                return answer('root done');
            }

            if (!request.messages.some((message) => message.role === 'assistant')) {
                return call('f1', 'threadFork', '{"input":"inspect"}');
            }

            return answer('waiting');
        });

        const { writer, home, sibling } = fixture(stream);
        const run = runThread(writer, home.id, 'go');
        await run.pump(() => run.state.settled);

        expect(run.state.failure).toBeUndefined();
        expect(run.state.content).toBe('root done');

        const record = writer.branches()[0];
        const branchId = record.branchId;
        // The branch counter is module-global across a file's harnesses, so the id is pinned
        // by shape here and by value everywhere it is used below.
        expect(branchId).toMatch(/^branch-\d+$/);

        // THE RECORD, every field derived from the branch ledger by `threadRecordOfBranch`:
        // `origin: 'host'` because a branch is a conversation ON TOP of an agent rather than
        // an agent's default; `status: 'idle'` because a terminal branch is done working;
        // `sequence` is its position in the retained ledger (kept in creation order);
        // `invocationId` IS the branch id, which is what makes `thread()` and `agentResult`
        // name the same run; `ownerThreadId` is the REQUESTER's persistent thread — the owner
        // whose delete cascades this branch away.
        expect(writer.thread(branchId)).toEqual({
            id: branchId,
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 1,
            ownerThreadId: home.id,
            invocationId: branchId
        });

        // THE TRANSCRIPT: the copied baseline (the fork's own unanswered call carries the
        // created-branch placeholder) plus the branch's own two turns, in order.
        expect(withoutIds(writer.threadMessages(branchId))).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_1`, name: 'threadFork', arguments: '{"input":"inspect"}' }
                ]
            },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_1`,
                name: 'threadFork'
            },
            { role: 'user', content: 'inspect' },
            { role: 'assistant', content: 'branch summary' }
        ]);

        // AN ADDRESS, NOT A ROSTER ENTRY. A branch is an invocation with an ephemeral
        // transcript; it holds no thread slot, so the roster is still exactly the default
        // conversation plus the two host conversations.
        expect(writer.threads().map((entry) => entry.id)).toEqual([
            'agent:writer',
            home.id,
            sibling.id
        ]);

        // THE HOST READ. A caller with no thread of its own is the host view and is UNSCOPED,
        // so the manual read accepts the branch id and pages what the branch committed.
        const page = JSON.parse(
            JSON.stringify(await writer.executeTool('threadRead', { thread: branchId }))
        ) as {
            thread: { id: string };
            total: number;
            matched: number;
            messages: Array<{ index: number; content: string }>;
        };
        expect({
            thread: page.thread.id,
            total: page.total,
            matched: page.matched,
            messages: page.messages.map((entry) => ({ index: entry.index, content: entry.content }))
        }).toEqual({
            thread: branchId,
            total: 5,
            matched: 5,
            messages: [
                { index: 0, content: 'go' },
                { index: 1, content: '' },
                { index: 2, content: BRANCH_PENDING_PLACEHOLDER.threadFork },
                { index: 3, content: 'inspect' },
                { index: 4, content: 'branch summary' }
            ]
        });

        // THE OWNER READS IT. `home` owns the branch, so the branch is inside its family and
        // both read seams answer the id for it.
        expect(writer.threadMessages(branchId, home.id).map((entry) => entry.content)).toEqual([
            'go',
            '',
            BRANCH_PENDING_PLACEHOLDER.threadFork,
            'inspect',
            'branch summary'
        ]);
        expect(writer.thread(branchId, home.id)?.invocationId).toBe(branchId);

        // A SIBLING does not inherit the lineage of the conversation that forked. The seam
        // `threadRead` reads through refuses it with the sentence for an id that EXISTS but is
        // not its to read — never the not-found sentence.
        const notVisible =
            `Thread "${branchId}" is not visible to thread "${sibling.id}": a read reaches your own thread, ` +
            'an ancestor, one of your descendants, or a default conversation (agent:<name>) your roster lists ' +
            '(see threadList). The id exists — it is simply outside your lineage.';

        expect(() => writer.threadMessages(branchId, sibling.id)).toThrow(notVisible);
        expect(() => writer.thread(branchId, sibling.id)).toThrow(notVisible);

        // AND THE MODEL FEELS IT TOO. The sibling's own run calls `threadRead` with the id;
        // what lands in ITS transcript is the refusal, so a conversation cannot borrow a
        // neighbour's branch address by guessing it.
        branchAddress = branchId;
        const second = runThread(writer, sibling.id, 'read the branch');
        await second.pump(() => second.state.settled);

        expect(second.state.failure).toBeUndefined();
        expect(second.state.content).toBe('sibling heard the refusal');
        // What the model is handed is the tool-call failure envelope around that sentence —
        // the same wrapper every other refused call gets, and it still names the id and the
        // reason.
        expect(toolResultsOf(writer, sibling.id)).toEqual([
            `Tool "threadRead" failed: ${notVisible}`
        ]);

        // AN UNKNOWN BRANCH ID IS THE CANONICAL UNKNOWN THREAD: one sentence for "gone" and
        // "never existed", on both read seams.
        expect(writer.thread('branch-999999')).toBeUndefined();
        expect(() => writer.threadMessages('branch-999999')).toThrow(
            'Thread "branch-999999" is not available in this harness; it was never created, or it was deleted.'
        );

        // A branch is not a thread SLOT, so the host's release keeps refusing it: its records
        // leave with its owner conversation (the M2 cascade), never on their own.
        //
        // WHAT CHANGED (stress report #4, 2026-11-14) is the SENTENCE. The refusal used to come
        // from `threadStateOf` and claim the id "was never created, or it was deleted" — the one
        // answer that is false two lines above, where `threadRead branch-N` served five messages
        // and `agentResult` served the record. The delete seam now resolves the branch ledger
        // first (`branchRecordOf`, ahead of `threadStateOf` in `deleteThread`) and states the
        // actual rule.
        const branchRefusal =
            `Thread "${branchId}" is a fork record, not a conversation: it holds no thread slot, so there is ` +
            `nothing to release — it goes when the conversation that forked it ("${home.id}") is deleted. ` +
            'The branch ledger keeps only its newest 64 records.';

        expect(() => writer.deleteThread(branchId)).toThrow(branchRefusal);

        // THE MODEL DOOR ANSWERS THE SAME WAY FOR A BRANCH IT OWNS, and the refusal is still a
        // refusal — no branch has become deletable.
        expect(() => writer.runtime.threadDelete(home.id, branchId)).toThrow(branchRefusal);

        // THE DESCENDANT GATE IS NOT LAUNDERED BY THE BRANCH LEDGER. `sibling` never forked
        // this branch, so it gets the lineage refusal (`threadDeleteFor`), not the owner-facing
        // one: a scoped caller cannot probe which subtree a branch belongs to by guessing its id.
        expect(() => writer.runtime.threadDelete(sibling.id, branchId)).toThrow(
            `Thread "${branchId}" is not one of the conversations "${sibling.id}" created; ` +
                'threadDelete releases your own descendants (see threadList) — never your current thread, ' +
                "an ancestor, a sibling, or another agent's conversation."
        );

        // AND AN ID THAT RESOLVES FOR NOBODY STILL GETS THE CANONICAL NOT-FOUND, on the delete
        // door exactly as on the two read seams above. `branch-999999` is not in the ledger, so
        // the new branch clause does not fire and "gone" stays indistinguishable from "never
        // existed" — which is what makes a reaping retry safe.
        expect(() => writer.deleteThread('branch-999999')).toThrow(
            'Thread "branch-999999" is not available in this harness; it was never created, or it was deleted.'
        );
        expect(() => writer.runtime.threadDelete(home.id, 'branch-999999')).toThrow(
            'Thread "branch-999999" is not available in this harness; it was never created, or it was deleted.'
        );
    });

    it('ends a branch on the bound its caller names, and reports the branch id that still addresses the work', async () => {
        let release!: () => void;
        const hold = new Promise<string>((resolve) => {
            release = () => resolve('released');
        });

        const stream = route({
            branchSettled: 'released',
            branchAnswer: 'branch done',
            rootAnswer: 'exceeded its 30ms timeout',
            forkArguments: '{"input":"inspect","timeoutMs":30}'
        });

        const { writer, home } = fixture(stream, { tools: holdTool(hold) });
        const run = runThread(writer, home.id, 'go');

        // The fork is live and parked inside its own tool call before any clock moves.
        await run.pump(() => writer.branches().length === 1);

        const branchId = writer.branches()[0].branchId;

        // THE CLOCK IS ARMED, and it is the only timer this harness holds: the branch is
        // running, and nothing else ends it on a clock.
        expect(vi.getTimerCount()).toBe(1);
        expect(writer.branch(branchId)?.status).toBe('running');
        expect(writer.thread(branchId)?.status).toBe('running');

        await advanceBy(31);
        await run.pump(() => run.state.settled);

        // A branch the clock stopped is a CANCELLATION, not a failure — the same control
        // outcome a `toolCancel` of the same call records — with the reason naming the branch
        // and the bound that fired. `branches()` hands out detached records, so the branch is
        // re-read through its id rather than read through the earlier snapshot.
        expect(writer.branch(branchId)).toMatchObject({
            status: 'cancelled',
            error: { message: `Thread branch "${branchId}" exceeded its 30ms timeout and was stopped.` }
        });
        expect(writer.branch(branchId)?.result).toBeUndefined();
        expect(run.state.content).toBe('exceeded its 30ms timeout:done');

        // WHAT REACHES THE REQUESTER names the branch id, because that id is the handle for
        // what survives: the sentence it reads is the branch's own abort reason, and B3
        // (2026-11-13) adds the clause that proves the work is not gone — the surviving
        // address, an inline preview of what the branch had produced, and the two doors
        // that read the rest. The preview is capped (FORK_PARTIAL_PREVIEW_CHARS in
        // src/harness.ts); the full text is what `agentResult` reports below.
        expect(forkDeliveries(writer, home.id)).toEqual([
            `Tool "threadFork" failed: Thread branch "${branchId}" exceeded its 30ms timeout and was stopped. — its branch "${branchId}" still holds what it produced: "started the work" — read it with threadRead "${branchId}" or agentResult by that id.`
        ]);

        // THE PARTIAL WORK STAYS READABLE BY THAT ID. The branch never gave a final summary;
        // what it had produced pages exactly like a finished answer would.
        const result = (await writer.executeTool('agentResult', {
            agent: 'writer',
            invocationId: branchId
        })) as Record<string, unknown>;
        expect({
            agent: result.agent,
            invocationId: result.invocationId,
            kind: result.kind,
            status: result.status,
            content: result.content,
            contentLength: result.contentLength,
            hasMore: result.hasMore,
            error: result.error,
            // B3 (2026-11-13): the WHOLE partial, as its own key. A timed-out branch is
            // forensically readable by its id: `content` is the page, `partialContent` is
            // the run's last substantive text, and a caller that only wants the gist gets
            // it in this one call. The key was missing before, which made the entry's own
            // prose ("the result carries the partial content it had produced") a promise
            // nothing honoured.
            partialContent: result.partialContent,
            cancelledAtMessage: result.cancelledAtMessage
        }).toEqual({
            agent: 'writer',
            invocationId: branchId,
            kind: 'fork',
            status: 'cancelled',
            content: 'started the work',
            contentLength: 16,
            hasMore: false,
            error: `Thread branch "${branchId}" exceeded its 30ms timeout and was stopped.`,
            partialContent: 'started the work',
            cancelledAtMessage: 2
        });

        // A terminal branch reports as a finished conversation, and its clock is DISARMED: no
        // timer is left pending once the branch has settled.
        expect(writer.thread(branchId)?.status).toBe('idle');
        expect(vi.getTimerCount()).toBe(0);

        release();
    });

    it('names the branch address when the requester cancels the fork call', async () => {
        const hold = new Promise<string>(() => undefined);

        const stream = route({
            branchAnswer: 'branch done',
            rootAnswer: 'still holds what it produced',
            forkArguments: '{"input":"inspect"}',
            cancel: true
        });

        const { writer, home } = fixture(stream, { tools: holdTool(hold) });
        const run = runThread(writer, home.id, 'go');
        await run.pump(() => run.state.settled);

        const branchId = writer.branches()[0].branchId;
        expect(run.state.failure).toBeUndefined();
        expect(run.state.content).toBe('still holds what it produced:done');
        expect(writer.branch(branchId)?.status).toBe('cancelled');

        // THE CANCELLATION SENTENCE. Every other cancelled call says "no result is available";
        // a FORK's work survives its own cancellation, so the sentence carries the branch id
        // and BOTH doors that read it. Pinned verbatim, because the whole point is that the id
        // is inside the text a model reads.
        expect(forkDeliveries(writer, home.id)).toEqual([
            `Tool call "threadFork" (f1) was cancelled before it completed; its branch "${branchId}" still holds what it produced — read it with threadRead "${branchId}" or agentResult by that id.`
        ]);

        // And the address it names is real. A cancelled run rolls back its OWN turns, so what
        // survives at that address is the baseline the branch was created from, up to and
        // including the fork call it was made to answer.
        expect(withoutIds(writer.threadMessages(branchId))).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_1`, name: 'threadFork', arguments: '{"input":"inspect"}' }
                ]
            },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_1`,
                name: 'threadFork'
            }
        ]);

        // The work it HAD produced is not lost either: it is the invocation's partial answer,
        // paged by the same id the sentence names. B3 (2026-11-13): `partialContent` is the
        // same text in ONE field, so a caller that cancels a fork reads what it got without
        // paging — and the key exists for a cancelled branch exactly as it does for a
        // cancelled delegation.
        const partial = (await writer.executeTool('agentResult', {
            agent: 'writer',
            invocationId: branchId
        })) as Record<string, unknown>;
        expect({
            agent: partial.agent,
            invocationId: partial.invocationId,
            kind: partial.kind,
            status: partial.status,
            content: partial.content,
            contentLength: partial.contentLength,
            hasMore: partial.hasMore,
            error: partial.error,
            partialContent: partial.partialContent,
            cancelledAtMessage: partial.cancelledAtMessage
        }).toEqual({
            agent: 'writer',
            invocationId: branchId,
            kind: 'fork',
            status: 'cancelled',
            content: 'started the work',
            contentLength: 16,
            hasMore: false,
            error: expect.stringContaining('aborted'),
            partialContent: 'started the work',
            cancelledAtMessage: 2
        });
    });

    it('takes the bound from the harness for a fork that names none, and arms no clock when nobody names one', async () => {
        let release!: () => void;
        const hold = new Promise<string>((resolve) => {
            release = () => resolve('released');
        });

        // THE HOST'S BACKSTOP. The model named no `timeoutMs`, so the configured value IS the
        // bound — the option that used to be declared and read by nobody.
        const stream = route({
            branchSettled: 'released',
            branchAnswer: 'branch done',
            rootAnswer: 'exceeded its 40ms timeout',
            forkArguments: '{"input":"inspect"}'
        });

        const { writer, home } = fixture(stream, { tools: holdTool(hold), threadForkTimeoutMs: 40 });
        const run = runThread(writer, home.id, 'go');
        await run.pump(() => writer.branches().length === 1);

        expect(writer.branches()[0].status).toBe('running');
        expect(vi.getTimerCount()).toBe(1);

        await advanceBy(41);
        await run.pump(() => run.state.settled);

        expect(run.state.content).toBe('exceeded its 40ms timeout:done');
        const boundedId = writer.branches()[0].branchId;
        expect(writer.branch(boundedId)).toMatchObject({
            status: 'cancelled',
            error: { message: `Thread branch "${boundedId}" exceeded its 40ms timeout and was stopped.` }
        });
        expect(vi.getTimerCount()).toBe(0);

        // UNSET MEANS NO LIMIT. The same fork on an unconfigured harness arms NO timer, and
        // twenty-five minutes of clock time change nothing: the branch still ends on its own
        // answer — released here by the tool it was parked in.
        release();

        let releaseTwo!: () => void;
        const holdTwo = new Promise<string>((resolve) => {
            releaseTwo = () => resolve('released');
        });

        const plain = fixture(
            route({
                branchSettled: 'released',
                branchAnswer: 'branch done',
                rootAnswer: 'branch done',
                forkArguments: '{"input":"inspect"}'
            }),
            { tools: holdTool(holdTwo) }
        );

        const plainRun = runThread(plain.writer, plain.home.id, 'go');
        await plainRun.pump(() => plain.writer.branches().length === 1);

        expect(plain.writer.branches()[0].status).toBe('running');
        expect(vi.getTimerCount()).toBe(0);

        await advanceBy(1_500_000);
        expect(plain.writer.branches()[0].status).toBe('running');

        releaseTwo();
        await plainRun.pump(() => plainRun.state.settled);

        expect(plainRun.state.content).toBe('branch done:done');
        const plainId = plain.writer.branches()[0].branchId;
        expect(plain.writer.branch(plainId)).toMatchObject({
            status: 'completed',
            result: { content: 'branch done' }
        });
    });
});
