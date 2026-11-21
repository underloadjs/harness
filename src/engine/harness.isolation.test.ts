// Two harness handles are separate worlds.
//
// Every mutable surface the handle exposes belongs to that handle: its tool
// registry, its knowledge base and its agents' transcripts. The one deliberate
// sharing door is a host-supplied knowledge engine/store — pass the SAME object and
// the two handles see one base; pass nothing and each builds its own.
//
// This suite uses only `harness({ ... })` and the object it returns, so the
// isolation claim is independent of any server/session layer.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type {
    Harness,
    HarnessStream,
    HarnessStreamEvent,
    KnowledgeCreateResult,
    KnowledgeEngine,
    KnowledgePageResult,
    KnowledgeReadResult
} from './index';
import { createKnowledgeEngine } from './core';

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const scripted = (text: string): HarnessStream => async function* stream() {
    yield* answer(text);
};

const make = (knowledge?: KnowledgeEngine): Harness =>
    harness({
        agents: { writer: agent({ model: 'scripted/test', stream: scripted('quiet') }) },
        entry: 'writer',
        presets: false,
        ...(knowledge === undefined ? {} : { knowledge })
    });

const create = (target: Harness, title: string): KnowledgeCreateResult =>
    (target.knowledge as KnowledgeEngine).execute({
        verb: 'create',
        title,
        content: ['body']
    }) as KnowledgeCreateResult;

const list = (target: Harness): KnowledgePageResult =>
    (target.knowledge as KnowledgeEngine).execute({ verb: 'list' }) as KnowledgePageResult;

describe('harness instance isolation', () => {
    it('shares no tool registry, knowledge base or transcript between two handles', async () => {
        const first = make();
        const second = make();

        await first.registerTool({
            definition: tool({
                name: 'onlyFirst',
                description: 'Registered on the first handle only.',
                tags: ['test'],
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                execute: () => ({ owner: 'first' })
            })
        });

        expect(first.tools.onlyFirst).toBeDefined();
        expect(second.tools.onlyFirst).toBeUndefined();

        const created = create(first, 'First only');

        expect(list(first).articles.map((article) => article.title)).toEqual(['First only']);
        expect(list(second).articles).toEqual([]);

        const secondMessages = second.agents.writer.messages;

        await first('tell me something');

        expect(secondMessages).toEqual([]);
        expect(first.agents.writer.messages.length).toBeGreaterThan(0);
        expect(created.article.title).toBe('First only');
    });

    it('shares a knowledge base only when the host passes the same engine to both', () => {
        const shared = createKnowledgeEngine();
        const first = make(shared);
        const second = make(shared);

        const created = create(first, 'Shared by configuration');

        expect(list(second).articles.map((article) => article.title)).toEqual([
            'Shared by configuration'
        ]);
        expect(
            ((second.knowledge as KnowledgeEngine).execute({
                verb: 'read',
                id: created.article.id
            }) as KnowledgeReadResult).title
        ).toBe('Shared by configuration');
    });
});
