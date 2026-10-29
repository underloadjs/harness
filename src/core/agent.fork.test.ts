// core/agent.ts — Agent.fork() (N3).
//
// Pinned contract:
//   - a fork clones the ENTIRE committed history (attachments, tool calls,
//     reasoning), the current model value, the instruction snapshot, and a
//     DETACHED reset baseline;
//   - branch identity lives outside the public Agent shape (`agentBranchOf`);
//   - tool ids are remapped and pending calls get the explicit non-success
//     placeholder, while the source transcript is never touched;
//   - ordinary forks nest to depth 2; an autoanswer fork inherits depth and does
//     not consume a level;
//   - the fork shares the source transport.

import { describe, expect, it } from 'vitest';
import { agent } from '@underload/harness';
import type {
    AgentStreamEvent,
    HarnessAttachment,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';
import {
    BRANCH_PENDING_PLACEHOLDER,
    agentBranchOf,
    forkAgent
} from './branch';

const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

const image = (overrides: Partial<HarnessAttachment> = {}): HarnessAttachment => ({
    id: 'img-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: PNG_BYTES.length,
    data: base64(PNG_BYTES),
    ...overrides
});

const done = (): HarnessStreamEvent => ({ type: 'done', stopReason: 'stop', toolCalls: [] });

const fakeStream = (
    seen: HarnessStreamRequest[] = [],
    frames: HarnessStreamEvent[] = [{ type: 'text', delta: 'ok' }, done()]
): HarnessStream =>
    async function* stream(request) {
        seen.push(request);
        for (const frame of frames) {
            yield frame;
        }
    };

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

describe('Agent.fork', () => {
    it('clones full history, model value, instructions and remaps tool ids', () => {
        const source = agent({
            name: 'writer',
            model: 'model-a',
            instruction: ['You are A.'],
            stream: fakeStream(),
            messages: [
                { role: 'user', content: 'hello' },
                {
                    role: 'assistant',
                    content: 'thinking',
                    reasoning: 'plan',
                    toolCalls: [{ id: 'origin-a', name: 'fileRead', arguments: '{}' }]
                },
                { role: 'tool', content: 'ok', toolCallId: 'origin-a', name: 'fileRead' },
                { role: 'assistant', content: 'done' }
            ]
        });

        const branch = source.fork();
        const meta = agentBranchOf(branch);

        expect(meta).toMatchObject({
            kind: 'fork',
            forkDepth: 1,
            model: 'model-a'
        });
        expect(meta!.branchId).toMatch(/^branch-[0-9]+$/);
        expect(branch.name).toBe('writer');
        expect(branch.instructions).toEqual(['You are A.']);
        expect(branch.model()).toBe('model-a');

        // The branch id is provider-safe, so the remapped namespace is the id.
        const branchId = meta!.branchId;
        expect(meta!.toolCallIds).toEqual([
            { origin: 'origin-a', branch: `call_${branchId}_1` }
        ]);
        expect(branch.messages).toEqual([
            { role: 'system', content: 'You are A.' },
            { role: 'user', content: 'hello' },
            {
                role: 'assistant',
                content: 'thinking',
                reasoning: 'plan',
                toolCalls: [{ id: `call_${branchId}_1`, name: 'fileRead', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'ok',
                toolCallId: `call_${branchId}_1`,
                name: 'fileRead'
            },
            { role: 'assistant', content: 'done' }
        ]);
    });

    it('pairs pending calls with the created-branch placeholder and leaves the source untouched', () => {
        const source = agent({
            model: 'm',
            stream: fakeStream(),
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'a', name: 'fileRead', arguments: '{}' },
                        { id: 'b', name: 'fileList', arguments: '[]' }
                    ]
                },
                { role: 'tool', content: 'A', toolCallId: 'a', name: 'fileRead' }
            ]
        });
        const before = JSON.parse(JSON.stringify(source.messages)) as HarnessMessage[];

        const branch = source.fork();
        const branchId = agentBranchOf(branch)!.branchId;

        expect(branch.messages).toEqual([
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_1`, name: 'fileRead', arguments: '{}' },
                    { id: `call_${branchId}_2`, name: 'fileList', arguments: '[]' }
                ]
            },
            { role: 'tool', content: 'A', toolCallId: `call_${branchId}_1`, name: 'fileRead' },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_2`,
                name: 'fileList'
            }
        ]);
        expect(source.messages).toEqual(before);
    });

    it('detaches the transcript, model accessor and reset baseline', () => {
        const source = agent({
            model: 'model-a',
            instruction: 'sys',
            stream: fakeStream(),
            messages: [{ role: 'user', content: 'hello' }]
        });
        const branch = source.fork();

        const stored = branch.messages[1] as Extract<HarnessMessage, { role: 'user' }>;
        stored.content = 'branch changed';

        expect(source.messages[1]).toEqual({ role: 'user', content: 'hello' });

        branch.model('model-b');
        expect(branch.model()).toBe('model-b');
        expect(source.model()).toBe('model-a');

        source.user('source-only');
        branch.user('branch-only');

        branch.reset();
        expect(branch.messages).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' }
        ]);
        expect(source.messages).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' },
            { role: 'user', content: 'source-only' }
        ]);
    });

    it('copies attachments deeply', () => {
        const sourceAttachment = image();
        const source = agent({ model: 'm', stream: fakeStream() });
        source.user('see [Image 1]', [sourceAttachment]);

        const branch = source.fork();
        const stored = branch.messages[0] as Extract<HarnessMessage, { role: 'user' }>;

        expect(stored).toEqual({
            role: 'user',
            content: 'see [Image 1]',
            attachments: [image()]
        });
        expect(stored.attachments![0]).not.toBe(sourceAttachment);

        stored.attachments![0].name = 'changed.png';
        const live = source.messages[0] as Extract<HarnessMessage, { role: 'user' }>;
        expect(live.attachments![0].name).toBe('pixel.png');
    });

    it('shares the source transport but not the source transcript', async () => {
        const seen: HarnessStreamRequest[] = [];
        const source = agent({
            model: 'm',
            instruction: 'sys',
            stream: fakeStream(seen)
        });
        const branch = source.fork();

        const events = await collect(branch.stream('hi'));

        expect(events).toEqual([
            { type: 'text', delta: 'ok' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'ok',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm',
                    stopReason: 'stop',
                    usage: undefined
                }
            }
        ]);
        expect(seen[0].messages).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' }
        ]);
        expect(source.messages).toEqual([{ role: 'system', content: 'sys' }]);
    });

    it('nests ordinary forks to depth 2 and rejects depth 3', () => {
        const source = agent({ model: 'm', stream: fakeStream() });
        const first = source.fork();
        const second = first.fork();

        expect(agentBranchOf(first)).toMatchObject({ kind: 'fork', forkDepth: 1 });
        expect(agentBranchOf(second)).toMatchObject({ kind: 'fork', forkDepth: 2 });
        expect(() => second.fork()).toThrow(
            'A fork at depth 3 exceeds maxDepth 2; forks may nest at most 2 levels deep.'
        );
    });

    it('does not consume depth for an autoanswer fork but records its request identity', () => {
        const source = agent({ model: 'm', stream: fakeStream() });
        const first = source.fork();
        const second = first.fork();

        const auto = forkAgent(second, {
            kind: 'autoanswer',
            requestId: 'req-1',
            callId: 'call-1',
            sourceThreadId: '7'
        });
        const meta = agentBranchOf(auto)!;

        expect(meta).toEqual({
            branchId: meta.branchId,
            kind: 'autoanswer',
            forkDepth: 2,
            model: 'm',
            callId: 'call-1',
            requestId: 'req-1',
            sourceThreadId: '7',
            toolCallIds: []
        });
        expect(meta.branchId).toMatch(/^branch-[0-9]+$/);
    });

    it('exposes deeply frozen branch metadata (object, mapping array and entries)', () => {
        const source = agent({
            model: 'm',
            stream: fakeStream(),
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'origin-a', name: 'fileRead', arguments: '{}' }]
                },
                { role: 'tool', content: 'ok', toolCallId: 'origin-a', name: 'fileRead' }
            ]
        });
        const branch = source.fork();
        const meta = agentBranchOf(branch)!;
        const original = meta.toolCallIds[0].branch;

        expect(Object.isFrozen(meta)).toBe(true);
        expect(Object.isFrozen(meta.toolCallIds)).toBe(true);
        expect(Object.isFrozen(meta.toolCallIds[0])).toBe(true);

        expect(() => {
            (meta.toolCallIds[0] as { branch: string }).branch = 'hacked';
        }).toThrow(TypeError);
        expect(() => {
            (meta.toolCallIds as Array<{ origin: string; branch: string }>).push({
                origin: 'x',
                branch: 'y'
            });
        }).toThrow(TypeError);

        expect(meta.toolCallIds[0].branch).toBe(original);
    });

    it('normalizes the optional display label', () => {
        const source = agent({ model: 'm', stream: fakeStream() });

        expect(agentBranchOf(source.fork({ label: '  Research  ' }))!.label).toBe('Research');
        expect(() => source.fork({ label: 'x'.repeat(121) })).toThrow(
            'Branch label is 121 characters; the maximum is 120.'
        );
    });
});
