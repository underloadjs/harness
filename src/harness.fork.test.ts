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

    it('carries the context-inclusion flag into a branch transcript and keeps the disabled unit off the branch request', async () => {
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

        // (2) The branch's own provider request runs through the same projection, so
        //     the disabled standalone turn and the ENTIRE disabled unit are absent —
        //     and the surviving pending-call pair stays exact.
        const branchRequest = seen.find((request) => latestUser(request) === 'inspect');
        expect(branchRequest).toBeDefined();
        expect(branchRequest!.messages).toEqual([
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'seed' },
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
        expect(pairIssues(branchRequest!.messages)).toEqual([]);
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
