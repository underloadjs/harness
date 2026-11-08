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
// The persistent-thread factory (core/thread.ts). A thread is the sibling clone path of
// `fork()` — same brain, different conversation — so the identity-color contract is
// pinned for BOTH in this file.
import { createThreadAgent } from './thread';

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
                    toolCalls: [{ id: 'origin-a', name: 'read', arguments: '{}' }]
                },
                { role: 'tool', content: 'ok', toolCallId: 'origin-a', name: 'read' },
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
        expect(withoutIds(branch.messages)).toEqual([
            { role: 'system', content: 'You are A.' },
            { role: 'user', content: 'hello' },
            {
                role: 'assistant',
                content: 'thinking',
                reasoning: 'plan',
                toolCalls: [{ id: `call_${branchId}_1`, name: 'read', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'ok',
                toolCallId: `call_${branchId}_1`,
                name: 'read'
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
                        { id: 'a', name: 'read', arguments: '{}' },
                        { id: 'b', name: 'files', arguments: '[]' }
                    ]
                },
                { role: 'tool', content: 'A', toolCallId: 'a', name: 'read' }
            ]
        });
        const before = JSON.parse(JSON.stringify(source.messages)) as HarnessMessage[];

        const branch = source.fork();
        const branchId = agentBranchOf(branch)!.branchId;

        expect(withoutIds(branch.messages)).toEqual([
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_1`, name: 'read', arguments: '{}' },
                    { id: `call_${branchId}_2`, name: 'files', arguments: '[]' }
                ]
            },
            { role: 'tool', content: 'A', toolCallId: `call_${branchId}_1`, name: 'read' },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_2`,
                name: 'files'
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

        expect(withoutIds(source.messages[1])).toEqual({ role: 'user', content: 'hello' });

        branch.model('model-b');
        expect(branch.model()).toBe('model-b');
        expect(source.model()).toBe('model-a');

        source.user('source-only');
        branch.user('branch-only');

        branch.reset();
        expect(withoutIds(branch.messages)).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' }
        ]);
        expect(withoutIds(source.messages)).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hello' },
            { role: 'user', content: 'source-only' }
        ]);
    });

    it('carries the context-inclusion flag through the fork clone and a branch reset', () => {
        // Stage 1b: `included` is transcript state, so a branch that forgot it
        // would put a turn the user disabled straight back in front of the model on
        // EVERY branch request. The flag rides the materialized transcript AND the
        // detached reset baseline, and only `false` is ever re-emitted.
        const source = agent({
            name: 'writer',
            model: 'model-a',
            instruction: ['You are A.'],
            stream: fakeStream(),
            messages: [
                { role: 'user', content: 'kept' },
                { role: 'user', content: 'disabled', included: false },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'origin-a', name: 'read', arguments: '{}' }]
                },
                {
                    role: 'tool',
                    content: 'ok',
                    toolCallId: 'origin-a',
                    name: 'read',
                    included: false
                },
                { role: 'assistant', content: 'done', included: true }
            ]
        });
        const before = JSON.parse(JSON.stringify(source.messages)) as HarnessMessage[];

        const branch = source.fork();
        const branchId = agentBranchOf(branch)!.branchId;
        const forked: HarnessMessage[] = [
            { role: 'system', content: 'You are A.' },
            { role: 'user', content: 'kept' },
            { role: 'user', content: 'disabled', included: false },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: `call_${branchId}_1`, name: 'read', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: 'ok',
                toolCallId: `call_${branchId}_1`,
                name: 'read',
                included: false
            },
            // The source entry said `included: true`; the copy drops it, because
            // absent (never `true`) is the canonical way to say "included".
            { role: 'assistant', content: 'done' }
        ];

        expect(withoutIds(branch.messages)).toEqual(forked);
        expect(JSON.stringify(branch.messages)).not.toContain('"included":true');
        // The source transcript is never mutated by a fork.
        // Exact, ids included: forking never rewrites the source transcript, so every
        // entry keeps the address it had (context T1.4 — a fork COPIES ids, it does not
        // re-mint them, and it certainly does not drop them from its owner).
        expect(source.messages).toEqual(before);

        // A branch re-seeds from a CLONED baseline on every reset, so the flags must
        // be in the baseline itself, not only in the first materialized copy.
        branch.user('appended after the fork');
        expect(withoutIds(branch.messages[branch.messages.length - 1])).toEqual({
            role: 'user',
            content: 'appended after the fork'
        });

        branch.reset();
        // A reset re-clones the baseline, so the flags are back exactly as they were
        // (the id column is not what this test is about — src/harness.fork.test.ts
        // pins what a fork does to ids).
        expect(withoutIds(branch.messages)).toEqual(forked);
    });

    // Compaction T1 — the same two-hop ride as the flag above. The outcome travels on the
    // MATERIALIZED transcript (core/branch.ts `copyOutcome`) AND on the detached reset
    // baseline (core/agent.ts `copyBaselineMessage`), and an explicit `completed` never
    // comes back as a string. A branch that forgot WHY a call ended could not answer "was
    // this work already superseded?" without re-reading prose — the exact thing the
    // classification exists to prevent.
    it('carries the persisted tool outcome through the fork clone and its reset baseline', () => {
        const source = agent({
            name: 'writer',
            model: 'model-a',
            instruction: ['You are A.'],
            stream: fakeStream(),
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'origin-a', name: 'read', arguments: '{}' },
                        { id: 'origin-b', name: 'write', arguments: '{}' }
                    ]
                },
                {
                    role: 'tool',
                    content: 'boom',
                    toolCallId: 'origin-a',
                    name: 'read',
                    outcome: 'failed'
                },
                {
                    role: 'tool',
                    content: 'ok',
                    toolCallId: 'origin-b',
                    name: 'write',
                    outcome: 'completed'
                }
            ]
        });

        const branch = source.fork();
        const branchId = agentBranchOf(branch)!.branchId;

        const forked: HarnessMessage[] = [
            { role: 'system', content: 'You are A.' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: `call_${branchId}_1`, name: 'read', arguments: '{}' },
                    { id: `call_${branchId}_2`, name: 'write', arguments: '{}' }
                ]
            },
            {
                role: 'tool',
                content: 'boom',
                toolCallId: `call_${branchId}_1`,
                name: 'read',
                outcome: 'failed'
            },
            // The healthy sibling carries NO key, so a fork of a pre-outcome transcript is
            // byte-identical to a fork of this one.
            { role: 'tool', content: 'ok', toolCallId: `call_${branchId}_2`, name: 'write' }
        ];

        expect(withoutIds(branch.messages)).toEqual(forked);
        expect(JSON.stringify(branch.messages)).not.toContain('"outcome":"completed"');
        expect(JSON.stringify(branch.messages)).toContain('"outcome":"failed"');

        branch.user('appended after the fork');
        branch.reset();

        // A reset re-clones the BASELINE, which is the copy path T1 updated: a baseline that
        // dropped the key would un-know the failure one turn later.
        expect(withoutIds(branch.messages)).toEqual(forked);
        expect((branch.messages[2] as Extract<HarnessMessage, { role: 'tool' }>).outcome).toBe(
            'failed'
        );
    });

    it('pairs a pending call of a disabled block with a disabled placeholder', () => {
        // The branch materializer mints a NEW tool message for an unanswered call.
        // It belongs to that call's unit, so it is disabled with it — otherwise the
        // branch transcript would hold an enabled answer to a withheld request.
        const source: HarnessMessage[] = [
            { role: 'user', content: 'prompt' },
            {
                role: 'assistant',
                content: '',
                included: false,
                toolCalls: [{ id: 'x', name: 'read', arguments: '{}' }]
            }
        ];

        const branch = agent({ model: 'm', stream: fakeStream(), messages: source }).fork();
        const branchId = agentBranchOf(branch)!.branchId;

        expect(withoutIds(branch.messages)).toEqual([
            { role: 'user', content: 'prompt' },
            {
                role: 'assistant',
                content: '',
                included: false,
                toolCalls: [{ id: `call_${branchId}_1`, name: 'read', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: BRANCH_PENDING_PLACEHOLDER.threadFork,
                toolCallId: `call_${branchId}_1`,
                name: 'read',
                included: false
            }
        ]);
    });

    it('copies attachments deeply', () => {
        const sourceAttachment = image();
        const source = agent({ model: 'm', stream: fakeStream() });
        source.user('see [Image 1]', [sourceAttachment]);

        const branch = source.fork();
        const stored = branch.messages[0] as Extract<HarnessMessage, { role: 'user' }>;

        expect(withoutIds(stored)).toEqual({
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
        expect(withoutIds(seen[0].messages)).toEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'hi' }
        ]);
        expect(withoutIds(source.messages)).toEqual([{ role: 'system', content: 'sys' }]);
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
                    toolCalls: [{ id: 'origin-a', name: 'read', arguments: '{}' }]
                },
                { role: 'tool', content: 'ok', toolCallId: 'origin-a', name: 'read' }
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

    // Identity color (R2) on a clone. A branch and a thread are the SAME brain in
    // another conversation: same name, same instructions, same transport. The swatch is
    // part of that identity, so every clone path carries it and no clone path can
    // quietly return a colorless agent a host would paint with a different color than
    // its source. Pinned alongside the label because both are identity metadata that
    // travels with the clone rather than with the transcript.
    it('carries the source identity color into every branch and thread', () => {
        const source = agent({ model: 'model-a', stream: fakeStream(), color: '#4ade80' });

        // Public fork, labelled fork, nested fork, and the runtime autoanswer fork.
        expect(source.fork().color).toBe('#4ade80');
        expect(source.fork({ label: 'Research' }).color).toBe('#4ade80');
        expect(source.fork().fork().color).toBe('#4ade80');
        expect(
            forkAgent(source, {
                kind: 'autoanswer',
                requestId: 'req-1',
                callId: 'call-1',
                sourceThreadId: '7'
            }).color
        ).toBe('#4ade80');

        // A persistent thread is an independent conversation of the same brain.
        const thread = createThreadAgent(source);
        expect(thread.color).toBe('#4ade80');
        expect(thread.name).toBe(source.name);

        // A branch of a branch of a thread keeps it as well, which is what stops the
        // swatch from drifting as the runtime nests work.
        expect(thread.fork().color).toBe('#4ade80');
    });

    it('leaves the color key absent on every clone of an uncolored source', () => {
        const source = agent({ model: 'model-a', stream: fakeStream() });

        // Not `color: undefined` — the key is absent, exactly as on the source, so a
        // host's "was a color configured?" test answers the same way everywhere.
        expect(Object.hasOwn(source, 'color')).toBe(false);
        expect(Object.hasOwn(source.fork(), 'color')).toBe(false);
        expect(Object.hasOwn(createThreadAgent(source), 'color')).toBe(false);
    });
});
