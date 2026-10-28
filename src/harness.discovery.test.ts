// Progressive discovery (R12) at the harness level.
//
// Contract pinned here:
//   - the first identical query returns the first capped page and a `remaining`
//     count of the matches still unseen;
//   - repeating the SAME query (same normalized tags, same limit) returns the NEXT
//     tranche, so the tail the cap hides is reachable at all;
//   - `remaining` always counts matches AFTER the returned page and reaches 0 when
//     the catalogue is exhausted;
//   - a later page reports `offset`; a first page does not, so its shape is
//     unchanged;
//   - once exhausted, an identical query starts a fresh first page;
//   - reset() forgets the progression with the rest of the discovery state.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

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

const brain = (stream: HarnessStream): ReturnType<typeof agent> =>
    agent({ model: 'merge/ds4-flash', stream });

// Eight searchable fixtures that all carry the exact tag "files", named so the
// deterministic name-order tiebreak decides both the pages and their order.
const fixtures = (count: number) =>
    Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
            const name = `file-${String(index).padStart(2, '0')}`;
            return [
                name,
                tool({ name, description: `${name} fixture.`, tags: ['files'], execute: () => name })
            ];
        })
    );

describe('progressive discovery', () => {
    it('advances a repeated identical query through the match tail', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                callTool('c2', 'toolRequest', '{"tags":["files"]}'),
                callTool('c3', 'toolRequest', '{"tags":["files"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');

        // Page 1: the first five, three still unseen.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'],
            tools: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'].map((name) => ({
                name,
                description: `${name} fixture.`,
                tags: ['files']
            })),
            remaining: 3,
            truncated: true
        });

        // Page 2: the tail, now with nothing left — the cap is no longer a dead end.
        expect(JSON.parse((entry.messages[4] as { content: string }).content)).toEqual({
            enabled: ['file-05', 'file-06', 'file-07'],
            tools: ['file-05', 'file-06', 'file-07'].map((name) => ({
                name,
                description: `${name} fixture.`,
                tags: ['files']
            })),
            remaining: 0,
            offset: 5
        });

        // Page 3: exhausted, so an identical query restarts at page 1.
        expect(JSON.parse((entry.messages[6] as { content: string }).content)).toEqual({
            enabled: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'],
            tools: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'].map((name) => ({
                name,
                description: `${name} fixture.`,
                tags: ['files']
            })),
            remaining: 3,
            truncated: true
        });

        // Every page is enabled as it arrives, in first-seen order.
        expect(writer.discoveredTools).toEqual([
            'file-00',
            'file-01',
            'file-02',
            'file-03',
            'file-04',
            'file-05',
            'file-06',
            'file-07'
        ]);
    });

    it('treats the same tags in a different order as the same query', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files","write"]}'),
                callTool('c2', 'toolRequest', '{"tags":["write","files"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');

        expect(JSON.parse((entry.messages[2] as { content: string }).content).enabled).toEqual([
            'file-00',
            'file-01',
            'file-02',
            'file-03',
            'file-04'
        ]);
        // Same normalized query, so it continues instead of repeating page 1.
        expect(JSON.parse((entry.messages[4] as { content: string }).content)).toMatchObject({
            enabled: ['file-05', 'file-06', 'file-07'],
            remaining: 0,
            offset: 5
        });
    });

    it('keeps a different query, or a different page size, on its own first page', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                callTool('c2', 'toolRequest', '{"tags":["files"],"limit":3}'),
                callTool('c3', 'toolRequest', '{"tags":["files"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');

        const firstPage = { enabled: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'], remaining: 3 };

        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toMatchObject(firstPage);

        // A narrower limit is a different page size, so it is a different question.
        expect(JSON.parse((entry.messages[4] as { content: string }).content)).toMatchObject({
            enabled: ['file-00', 'file-01', 'file-02'],
            remaining: 5
        });

        // ... and the untruncated query continues where IT left off.
        expect(JSON.parse((entry.messages[6] as { content: string }).content)).toMatchObject({
            enabled: ['file-05', 'file-06', 'file-07'],
            remaining: 0,
            offset: 5
        });
    });

    it('forgets the progression on reset()', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                answer('first'),
                callTool('c2', 'toolRequest', '{"tags":["files"]}'),
                answer('second')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: fixtures(8), presets: false });

        await writer('go');
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toMatchObject({
            enabled: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'],
            remaining: 3
        });

        writer.reset();
        await writer('again');

        // A reset is "start over": page 1 again, not the tail of the old query.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            enabled: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'],
            tools: ['file-00', 'file-01', 'file-02', 'file-03', 'file-04'].map((name) => ({
                name,
                description: `${name} fixture.`,
                tags: ['files']
            })),
            remaining: 3,
            truncated: true
        });
    });
});
