// N6 runtime: actionRequest owner interaction.
//
// Contract pinned here:
//   - ROOT requests are answered only by `interaction.actionRequest`; without a
//     handler the tool fails specifically and NEVER selects `recommended`;
//   - a CHILD/FORK request is answered by a tool-free, one-iteration owner fork of
//     the immediate parent run, whose transcript contains the owner's FULL
//     history plus the requester's FULL history (earlier invocations included);
//   - the answer reaches the requesting model through the normal scheduler as one
//     tool result carrying the resolved label/description (or custom text);
//   - `action_request` is emitted before the host, `action_answer` before
//     `tool_result`; a cancellation/late host answer never becomes a fake answer;
//   - an invalid/blank owner answer is an explicit tool error, never a fallback to
//     the recommendation; at most four requests may await an owner;
//   - executeTool refuses actionRequest because a manual call has no owner run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '@underload/harness';
// Read verbatim from its own module (the internal-import convention
// src/harness.snapshot.test.ts uses), so the quoted-instruction wording cannot
// drift between the helper and the assertion.
import { quotedBranchSystemInstruction } from './core/branch';
import type {
    Agent,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessActionRequestContext,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

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
): HarnessStreamEvent[] => [{ type: 'done', stopReason: 'tool_calls', toolCalls }];

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

const realToolContents = (request: HarnessStreamRequest): string[] =>
    toolMessages(request)
        .map((message) => message.content)
        .filter((content) => !content.includes('"status":"pending"'));

const brain = (stream: HarnessStream): Agent =>
    agent({ model: 'merge/ds4-flash', stream });

// The strict pairing invariant an incorporated branch history must keep (the R3
// check of src/harness.background.test.ts `wireIssues`, restated here because that
// oracle is not a package export): every assistant `toolCalls` block is followed
// immediately by exactly one tool message per call, in call order, and no tool
// message sits outside such a run.
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

const REQUEST_ARGS = JSON.stringify({
    question: 'Which path should I take?',
    recommended: 'fast',
    options: [
        { id: 'fast', label: 'Fast path', description: 'Ship quickly.' },
        { id: 'slow', label: 'Slow path' }
    ]
});

const REQUEST: HarnessActionRequest = {
    requestId: 'request-1',
    question: 'Which path should I take?',
    recommended: 'fast',
    options: [
        { id: 'fast', label: 'Fast path', description: 'Ship quickly.' },
        { id: 'slow', label: 'Slow path' }
    ],
    allowCustom: true
};

const rootRoute = (request: HarnessStreamRequest): HarnessStreamEvent[] => {
    const results = realToolContents(request);
    if (results.some((content) => content.includes('"answeredBy"'))) return answer('root done');
    if (!request.messages.some((message) => message.role === 'assistant')) {
        return call('q1', 'actionRequest', REQUEST_ARGS);
    }
    return answer('waiting');
};

const isDirective = (request: HarnessStreamRequest): boolean =>
    latestUser(request).startsWith('You are the OWNER');

describe('actionRequest runtime', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('awaits a root handler, then resolves the option with its label and description', async () => {
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];
        const handler = deferred<HarnessActionChoice>();
        let context: HarnessActionRequestContext | undefined;

        const entry = brain(routed(rootRoute, seen));
        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: {
                actionRequest: async (received, signal) => {
                    expect(signal.aborted).toBe(false);
                    context = received;
                    return handler.promise;
                }
            },
            report: { progress: (event) => void events.push(event) }
        });

        const running = writer('go');
        await flush();

        expect(context).toEqual({
            requestId: 'request-1',
            agent: 'writer',
            callId: 'q1',
            request: REQUEST
        });

        expect(events.some((event) => event.type === 'action_request')).toBe(true);
        expect(events.some((event) => event.type === 'action_answer')).toBe(false);

        handler.resolve({ kind: 'option', optionId: 'slow' });
        await running;
        await flush();

        const requestIndex = events.findIndex((event) => event.type === 'action_request');
        const answerIndex = events.findIndex((event) => event.type === 'action_answer');
        const resultIndex = events.findIndex(
            (event) => event.type === 'tool_result' && event.name === 'actionRequest'
        );

        expect(requestIndex).toBeGreaterThanOrEqual(0);
        expect(requestIndex).toBeLessThan(answerIndex);
        expect(answerIndex).toBeLessThan(resultIndex);

        expect(events[answerIndex]).toMatchObject({
            type: 'action_answer',
            agent: 'writer',
            requestId: 'request-1',
            answer: {
                requestId: 'request-1',
                choice: { kind: 'option', optionId: 'slow' },
                source: 'owner'
            }
        });

        const result = entry.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'actionRequest'
        );

        expect(JSON.parse(result!.content)).toEqual({
            requestId: 'request-1',
            answeredBy: 'owner',
            choice: { kind: 'option', optionId: 'slow', label: 'Slow path' }
        });

        // The root declaration list includes both branch controls.
        expect((seen[0].tools ?? []).map((declaration) => declaration.name)).toEqual([
            'toolRequest',
            'task'
        ]);
    });

    it('returns a custom answer unchanged', async () => {
        const entry = brain(routed(rootRoute));
        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: {
                actionRequest: async () => ({ kind: 'custom', text: 'Neither — split it.' })
            }
        });

        await writer('go');
        await flush();

        const result = entry.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'actionRequest'
        );

        expect(JSON.parse(result!.content)).toEqual({
            requestId: 'request-1',
            answeredBy: 'owner',
            choice: { kind: 'custom', text: 'Neither — split it.' }
        });
    });

    it('fails a root request specifically when no handler exists and never recommends', async () => {
        const events: HarnessEvent[] = [];
        const entry = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('no interaction.actionRequest'))) {
                    return answer('recovered');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('q1', 'actionRequest', REQUEST_ARGS);
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            // interaction without a handler is exactly the "no owner" root case.
            interaction: {},
            report: { progress: (event) => void events.push(event) }
        });

        expect(writer.tools.actionRequest).toBeDefined();

        const message = await writer('go');
        await flush();

        expect(message.content).toBe('recovered');
        const result = entry.messages.find(
            (entryMessage): entryMessage is Extract<HarnessMessage, { role: 'tool' }> =>
                entryMessage.role === 'tool' && entryMessage.name === 'actionRequest'
        );
        expect(result?.content).toContain(
            'actionRequest cannot be answered: this root run has no interaction.actionRequest handler. The recommendation is never selected automatically.'
        );
        expect(result?.content).not.toContain('"answeredBy"');
        expect(events.some((event) => event.type === 'action_answer')).toBe(false);
    });

    it('aborts a pending root request and ignores a late host answer', async () => {
        const events: HarnessEvent[] = [];
        const handler = deferred<HarnessActionChoice>();
        let observed: AbortSignal | undefined;

        const entry = brain(routed(rootRoute));
        const writer = harness({
            agents: { writer: entry },
            presets: false,
            interaction: {
                actionRequest: async (_context, signal) => {
                    observed = signal;
                    return handler.promise;
                }
            },
            report: { progress: (event) => void events.push(event) }
        });

        const controller = new AbortController();
        const running = writer('go', { signal: controller.signal });

        await flush();
        expect(observed?.aborted).toBe(false);

        controller.abort(new Error('stop now'));

        await expect(running).rejects.toThrow('stop now');
        await flush();

        const beforeLateAnswer = events.filter((event) => event.type === 'action_answer');
        expect(beforeLateAnswer).toEqual([]);

        // A handler that ignores its signal may still resolve; the result must not
        // be inserted into a rolled-back transcript or reported as an answer.
        handler.resolve({ kind: 'option', optionId: 'fast' });
        await flush();

        expect(events.filter((event) => event.type === 'action_answer')).toEqual([]);
        expect(
            entry.messages.some(
                (message) => message.role === 'tool' && message.name === 'actionRequest'
            )
        ).toBe(false);
        expect(observed?.aborted).toBe(true);
    });

    it('auto-answers a subagent request from the owner fork with both full histories', async () => {
        const events: HarnessEvent[] = [];
        const writerSeen: HarnessStreamRequest[] = [];

        const helper = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('"answeredBy":"auto"'))) {
                    return answer('child done');
                }
                if (latestUser(request) === 'previous task') return answer('previous answer');
                if (latestUser(request) === 'do work') return call('q1', 'actionRequest', REQUEST_ARGS);
                return answer('waiting');
            })
        );
        // A system instruction on the requester is what the incorporation helper
        // must demote to quoted user data inside the owner fork.
        helper.system('HELPER SYS');

        const lead = brain(
            routed((request) => {
                if (isDirective(request)) return answer('option:fast');

                const results = realToolContents(request);
                if (results.some((content) => content.includes('child done'))) {
                    return answer('owner done');
                }
                if (results.some((content) => content.includes('previous answer'))) {
                    return call('d2', 'delegate', '{"agent":"helper","input":"do work"}');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('d1', 'delegate', '{"agent":"helper","input":"previous task"}');
                }
                return answer('waiting');
            }, writerSeen)
        );

        const writer = harness({
            agents: { writer: lead, helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            interaction: { actionRequest: async () => ({ kind: 'option', optionId: 'fast' }) },
            report: { progress: (event) => void events.push(event) }
        });
        lead.system('OWNER SYS');

        await writer('owner start');
        await flush();

        const autoRequest = writerSeen.find(isDirective);
        expect(autoRequest).toBeDefined();
        expect(autoRequest?.tools).toEqual([]);

        const messages = autoRequest!.messages;
        const contents = messages.map((message) => message.content).join('\n');

        // Owner history and the requester's ENTIRE history (previous invocation
        // included) are both present, separated by the quoted-data boundary.
        expect(contents).toContain('owner start');
        expect(contents).toContain('BEGIN BRANCH HISTORY');
        expect(contents).toContain('previous task');
        expect(contents).toContain('previous answer');
        expect(contents).toContain('do work');
        expect(contents).toContain('Which path should I take?');

        // The helper's system instruction is quoted user DATA, never a new system
        // message in the owner's transcript.
        const quotedSystem = messages.find(
            (message) =>
                message.role === 'user' &&
                message.content.startsWith('[Quoted system instruction from branch')
        );
        expect(quotedSystem).toBeDefined();
        expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);

        const answerEvent = events.find((event) => event.type === 'action_answer');
        expect(answerEvent).toMatchObject({
            type: 'action_answer',
            requestId: 'request-1',
            answer: {
                requestId: 'request-1',
                choice: { kind: 'option', optionId: 'fast' },
                source: 'auto'
            }
        });

        const autoBranch = writer.branches()[0];
        expect(autoBranch.kind).toBe('autoanswer');
        expect(autoBranch.role).toBe('primary');
        expect(autoBranch.requestId).toBe('request-1');
        expect(autoBranch.status).toBe('completed');
        expect((answerEvent as Extract<HarnessEvent, { type: 'action_answer' }>).answer.branchId).toBe(
            autoBranch.branchId
        );

        // Every autoanswer frame carries kind + branchId.
        const autoFrames = events.filter(
            (event) => event.thread?.branchId === autoBranch.branchId
        );
        expect(autoFrames.length).toBeGreaterThan(0);
        expect(autoFrames.every((event) => event.thread?.kind === 'autoanswer')).toBe(true);

        const helperResult = helper.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'actionRequest'
        );
        expect(JSON.parse(helperResult!.content)).toEqual({
            requestId: 'request-1',
            answeredBy: 'auto',
            choice: { kind: 'option', optionId: 'fast', label: 'Fast path', description: 'Ship quickly.' }
        });

        // The owner transcript is untouched by the fork: no branch history, no
        // question, no directive.
        expect(
            lead.messages
                .filter((message) => message.role === 'user')
                .map((message) => message.content)
        ).toEqual(['owner start']);
        expect(lead.messages.some((message) => message.content.includes('Which path'))).toBe(false);
    });

    it('carries the context-inclusion flag into the autoanswer owner fork and keeps disabled turns off its request', async () => {
        const writerSeen: HarnessStreamRequest[] = [];

        const helper = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.some((content) => content.includes('"answeredBy":"auto"'))) {
                    return answer('child done');
                }
                if (latestUser(request) === 'do work') return call('q1', 'actionRequest', REQUEST_ARGS);
                return answer('waiting');
            })
        );
        // A DISABLED child instruction. Incorporation demotes it to a quoted USER
        // wrapper, and the wrapper has to inherit the flag or a turn the user turned
        // off would ride into the owner's context as a fresh, enabled message.
        helper.system('HELPER SYS');
        (helper.messages[helper.messages.length - 1] as HarnessMessage).included = false;

        const lead = agent({
            model: 'merge/ds4-flash',
            stream: routed((request) => {
                if (isDirective(request)) return answer('option:fast');

                const results = realToolContents(request);
                if (results.some((content) => content.includes('child done'))) {
                    return answer('owner done');
                }
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('d1', 'delegate', '{"agent":"helper","input":"do work"}');
                }
                return answer('waiting');
            }, writerSeen),
            // A disabled OWNER turn: the owner fork reads the owner's full history,
            // so the copy must carry the flag and the projection must withhold it.
            messages: [
                { role: 'user', content: 'owner seed' },
                { role: 'user', content: 'owner seed disabled', included: false }
            ]
        });

        const writer = harness({
            agents: { writer: lead, helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            interaction: { actionRequest: async () => ({ kind: 'option', optionId: 'fast' }) }
        });
        lead.system('OWNER SYS');

        await writer('owner start');
        await flush();

        const autoBranch = writer.branches().find((record) => record.kind === 'autoanswer');
        expect(autoBranch).toBeDefined();

        // (1) The autoanswer branch transcript is the incorporated history, flags
        //     included: the disabled owner turn kept its flag, and the disabled child
        //     instruction became a flagged quoted wrapper instead of an enabled one.
        expect(
            autoBranch!.messages.filter(
                (message) =>
                    message.content === 'owner seed disabled' ||
                    message.content.startsWith('[Quoted system instruction from branch')
            )
        ).toEqual([
            { role: 'user', content: 'owner seed disabled', included: false },
            {
                role: 'user',
                content: quotedBranchSystemInstruction(autoBranch!.branchId, 'HELPER SYS'),
                included: false
            }
        ]);
        expect(JSON.stringify(autoBranch!.messages)).not.toContain('"included":true');

        // (2) The owner fork's provider request withholds both disabled entries, and
        //     the incorporated tool-call blocks stay pair-complete (a branch history
        //     is exactly the transcript where a missing result would hurt).
        const autoRequest = writerSeen.find(isDirective);
        expect(autoRequest).toBeDefined();

        expect(autoRequest!.messages.some((message) => message.content === 'owner seed disabled')).toBe(
            false
        );
        expect(
            autoRequest!.messages.some((message) =>
                message.content.startsWith('[Quoted system instruction from branch')
            )
        ).toBe(false);
        expect(pairIssues(autoRequest!.messages)).toEqual([]);
        expect(JSON.stringify(autoRequest!.messages)).not.toContain('included');

        // (3) Only the owner's own system instruction keeps system privilege, and it
        //     was never flagged.
        expect(autoRequest!.messages.filter((message) => message.role === 'system')).toEqual([
            { role: 'system', content: 'OWNER SYS' }
        ]);
    });

    it('fails an invalid or blank owner answer instead of selecting the recommendation', async () => {
        const build = (directive: string) => {
            const helper = brain(
                routed((request) => {
                    const results = realToolContents(request);
                    if (results.some((content) => content.includes('did not answer') || content.includes('blank'))) {
                        return answer('after invalid');
                    }
                    if (!request.messages.some((message) => message.role === 'assistant')) {
                        return call('q1', 'actionRequest', REQUEST_ARGS);
                    }
                    return answer('waiting');
                })
            );

            const owner = brain(
                routed((request) => {
                    if (isDirective(request)) return answer(directive);
                    const results = realToolContents(request);
                    if (results.length > 0) return answer('owner done');
                    if (!request.messages.some((message) => message.role === 'assistant')) {
                        return call('d1', 'delegate', '{"agent":"helper","input":"go"}');
                    }
                    return answer('waiting');
                })
            );

            return { helper, owner };
        };

        const invalid = build('I think fast is best.');
        const invalidHarness = harness({
            agents: { writer: invalid.owner, helper: invalid.helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            interaction: { actionRequest: async () => ({ kind: 'option', optionId: 'fast' }) }
        });

        await invalidHarness('go');
        await flush();

        const invalidResult = invalid.helper.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'actionRequest'
        );
        expect(invalidResult?.content).toContain('did not answer with exactly "option:<id>"');
        expect(invalidResult?.content).not.toContain('"answeredBy"');
        expect(invalidHarness.branches()[0].status).toBe('failed');

        const blank = build('   ');
        const blankHarness = harness({
            agents: { writer: blank.owner, helper: blank.helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            interaction: { actionRequest: async () => ({ kind: 'option', optionId: 'fast' }) }
        });

        await blankHarness('go');
        await flush();

        const blankResult = blank.helper.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'actionRequest'
        );
        expect(blankResult?.content).toContain('blank action answer');
        expect(blankHarness.branches()[0].status).toBe('failed');
    });

    it('emits one cancelled autoanswer branch_end when the run aborts during branch_start', async () => {
        const events: HarnessEvent[] = [];
        const controller = new AbortController();
        let aborted = false;
        let hostCalled = false;

        const helper = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.length > 0) return answer('child done');
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('q1', 'actionRequest', REQUEST_ARGS);
                }
                return answer('waiting');
            })
        );

        const lead = brain(
            routed((request) => {
                if (isDirective(request)) return answer('option:fast');
                const results = realToolContents(request);
                if (results.length > 0) return answer('owner done');
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('d1', 'delegate', '{"agent":"helper","input":"go"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { writer: lead, helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            interaction: {
                actionRequest: async () => {
                    hostCalled = true;
                    return { kind: 'option', optionId: 'fast' };
                }
            },
            report: {
                progress: (event) => {
                    events.push(event);
                    if (
                        event.type === 'branch_start' &&
                        event.thread?.kind === 'autoanswer' &&
                        !aborted
                    ) {
                        aborted = true;
                        controller.abort(new Error('abort at auto branch start'));
                    }
                }
            }
        });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'abort at auto branch start'
        );
        await flush();

        const starts = events.filter(
            (event) => event.type === 'branch_start' && event.thread?.kind === 'autoanswer'
        );
        const ends = events.filter(
            (event) => event.type === 'branch_end' && event.thread?.kind === 'autoanswer'
        );

        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({
            type: 'branch_end',
            branchId: (starts[0] as Extract<HarnessEvent, { type: 'branch_start' }>).branch.branchId,
            status: 'cancelled'
        });

        const record = writer.branches()[0];
        expect(record.kind).toBe('autoanswer');
        expect(record.status).toBe('cancelled');
        expect(record.error).toEqual({
            message:
                'The requesting run ended before this branch could start; the branch was cancelled.'
        });
        expect(hostCalled).toBe(false);
        expect(events.filter((event) => event.type === 'action_answer')).toHaveLength(0);

        await flush();
        expect(
            events.filter(
                (event) => event.type === 'branch_end' && event.thread?.kind === 'autoanswer'
            )
        ).toHaveLength(1);
    });

    it('bounds concurrent pending requests at four and refuses manual execution', async () => {
        const five = calls(
            ...Array.from({ length: 5 }, (_, index) => ({
                id: `q${index + 1}`,
                name: 'actionRequest',
                arguments: JSON.stringify({
                    question: `Question ${index + 1}`,
                    recommended: 'yes',
                    options: [
                        { id: 'yes', label: 'Yes' },
                        { id: 'no', label: 'No' }
                    ]
                })
            }))
        );

        const helper = brain(
            routed((request) => {
                const results = realToolContents(request);
                if (results.length >= 5) return answer('child done');
                if (!request.messages.some((message) => message.role === 'assistant')) return five;
                return answer('waiting');
            })
        );

        const owner = brain(
            routed((request) => {
                if (isDirective(request)) return answer('option:yes');
                const results = realToolContents(request);
                if (results.length > 0) return answer('owner done');
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return call('d1', 'delegate', '{"agent":"helper","input":"go"}');
                }
                return answer('waiting');
            })
        );

        const writer = harness({
            agents: { writer: owner, helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            interaction: { actionRequest: async () => ({ kind: 'option', optionId: 'yes' }) }
        });

        await writer('go');
        await flush();

        const results = helper.messages.filter(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.name === 'actionRequest'
        );
        expect(results).toHaveLength(5);
        expect(results.filter((message) => message.content.includes('already awaiting an owner'))).toHaveLength(1);
        expect(results.filter((message) => message.content.includes('"answeredBy":"auto"'))).toHaveLength(4);
        expect(writer.branches()).toHaveLength(4);

        await expect(writer.executeTool('actionRequest', JSON.parse(REQUEST_ARGS))).rejects.toThrow(
            'Tool "actionRequest" is not available through executeTool: it requires the harness run that owns the conversation.'
        );
    });

    it('refuses a child request when autoAnswer is disabled or forks are disabled', async () => {
        const build = (configuration: Record<string, unknown>) => {
            const helper = brain(
                routed((request) => {
                    const results = realToolContents(request);
                    if (results.some((content) => content.includes('cannot be answered'))) {
                        return answer('after refusal');
                    }
                    if (!request.messages.some((message) => message.role === 'assistant')) {
                        return call('q1', 'actionRequest', REQUEST_ARGS);
                    }
                    return answer('waiting');
                })
            );
            const owner = brain(
                routed((request) => {
                    if (isDirective(request)) return answer('option:fast');
                    const results = realToolContents(request);
                    if (results.length > 0) return answer('owner done');
                    if (!request.messages.some((message) => message.role === 'assistant')) {
                        return call('d1', 'delegate', '{"agent":"helper","input":"go"}');
                    }
                    return answer('waiting');
                })
            );
            return { helper, owner, configuration };
        };

        for (const config of [
            { interaction: { autoAnswer: false } },
            { interaction: {}, forks: { enabled: false } }
        ]) {
            const built = build(config as Record<string, unknown>);
            const writer = harness({
                agents: { writer: built.owner, helper: built.helper },
                primary: 'writer',
                subagents: ['helper'],
                presets: false,
                ...(config as object)
            });

            await writer('go');
            await flush();

            const result = built.helper.messages.find(
                (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                    message.role === 'tool' && message.name === 'actionRequest'
            );
            expect(result?.content).toContain('cannot be answered');
            expect(result?.content).not.toContain('"answeredBy"');
        }
    });
});
