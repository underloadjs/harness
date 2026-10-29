// profileManage / chapterManage / locationManage in the harness — declaration,
// turns, sharing, isolation, reset, reservation, and recoverable errors.
//
// These tests sit next to harness() because they pin harness integration, while
// src/core/profile.test.ts, chapter.test.ts, and location.test.ts cover the tool
// implementations:
//   - all three are core, declared on the very first request, immediately after
//     todoManage;
//   - state persists across harness calls and is shared by every agent;
//   - a second harness starts empty; reset() clears all three stores and restarts
//     their id sequences;
//   - configured tools, plugins, and dynamic creation cannot claim the names;
//   - invalid input becomes a readable, recoverable tool result.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

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

const CORE_ORDER = [
    'toolRequest',
    'toolCreate',
    'todoManage',
    'profileManage',
    'chapterManage',
    'locationManage',
    'agentManage',
    'agentResult'
];

// N6: threadFork is core for every agent; agentDelegate stays primary-only and is
// declared BEFORE threadFork (registration order).
const CORE_ORDER_PRIMARY = [...CORE_ORDER, 'agentDelegate', 'threadFork'];
const CORE_ORDER_SUBAGENT = [...CORE_ORDER, 'threadFork'];

// R9 bounded shapes (src/core/{profile,chapter,location}.ts):
//   list  -> { <kind>s, counts, page }  (default 20, max 100, 64 KiB page budget)
//   write -> { <kind>|removed, counts } (no list)
//   get   -> { <kind>, counts }         (chapter adds `content`)
// `nextOffset` is omitted when `hasMore` is false, hence the exact shape here.
const page = (offset = 0, limit = 20, hasMore = false) => ({ offset, limit, hasMore });

const emptyProfiles = { profiles: [], counts: { total: 0 }, page: page() };
const emptyChapters = {
    chapters: [],
    counts: { total: 0, planned: 0, draft: 0, complete: 0 },
    page: page()
};
const emptyLocations = { locations: [], counts: { total: 0 }, page: page() };

// The one profile every add in this file creates.
const ELENA = { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' };

describe('session record tools', () => {
    it('are core and declared on the first request immediately after todoManage', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    callTool(
                        'c1',
                        'profileManage',
                        '{"action":"add","name":"Elena","description":"A cartographer."}'
                    ),
                    answer('added')
                ],
                seen
            )
        );
        const writer = quiet(entry);

        expect(writer.tools.profileManage.visibility).toBe('core');
        expect(writer.tools.chapterManage.visibility).toBe('core');
        expect(writer.tools.locationManage.visibility).toBe('core');

        await writer('remember Elena');

        // toolRequest is never called, yet the record tools were declared.
        expect(declaredNames(seen[0])).toEqual(CORE_ORDER_SUBAGENT);
        expect((entry.messages[2] as { content: string }).content).toBe(
            `{"profile":${JSON.stringify(ELENA)},"counts":{"total":1}}`
        );
    });

    it('share one store of each kind with every agent in the same harness', async () => {
        const writerSeen: HarnessStreamRequest[] = [];
        const researcherSeen: HarnessStreamRequest[] = [];

        const researcher = brain(
            scripted(
                [callTool('r1', 'profileManage', '{"action":"list"}'), answer('saw the profiles')],
                researcherSeen
            )
        );

        // A core sibling tool is enough to enter the researcher's run and prove
        // the same profileManage instance serves both brains.
        const peek = tool({
            description: 'Ask the researcher who is in the cast.',
            tags: ['agents', 'inspect'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('researcher', 'list the cast')).content
        });

        const entry = brain(
            scripted(
                [
                    callTool(
                        'c1',
                        'profileManage',
                        '{"action":"add","name":"Elena","description":"A cartographer."}'
                    ),
                    callTool('c2', 'peek', '{}'),
                    answer('done')
                ],
                writerSeen
            )
        );

        const writer = harness({
            agents: { writer: entry, researcher },
            tools: { peek },
            presets: false
        });

        await writer('record and inspect');

        // The researcher's list is the primary's profile, not an empty list.
        expect(JSON.parse((researcher.messages[2] as { content: string }).content)).toEqual({
            profiles: [ELENA],
            counts: { total: 1 },
            page: page()
        });

        // Configured tools precede the harness-owned set; agentDelegate is
        // primary-only, and threadFork follows it in registration order.
        expect(declaredNames(writerSeen[0])).toEqual(['peek', ...CORE_ORDER_PRIMARY]);
        expect(declaredNames(researcherSeen[0])).toEqual(['peek', ...CORE_ORDER_SUBAGENT]);
    });

    it('keeps records across calls, isolates harnesses, and clears on reset', async () => {
        const writerA = quiet(brain(scripted([answer('hi')])));
        const writerB = quiet(brain(scripted([answer('hi')])));

        // Separate factory instances per harness: not the same tool objects.
        expect(writerA.tools.profileManage).not.toBe(writerB.tools.profileManage);
        expect(writerA.tools.chapterManage).not.toBe(writerB.tools.chapterManage);
        expect(writerA.tools.locationManage).not.toBe(writerB.tools.locationManage);

        // The host-side executeTool path mutates the same session stores.
        await writerA.executeTool('profileManage', {
            action: 'add',
            name: 'Elena',
            description: 'A cartographer.'
        });
        await writerA.executeTool('chapterManage', {
            action: 'add',
            title: 'Arrival',
            summary: 'They land.',
            content: 'The ship settles.'
        });
        await writerA.tools.locationManage({ action: 'add', name: 'Harbour', description: 'A port.' });

        // A second harness (a second session) sees none of it.
        expect(await writerB.tools.profileManage({ action: 'list' })).toEqual(emptyProfiles);
        expect(await writerB.tools.chapterManage({ action: 'list' })).toEqual(emptyChapters);
        expect(await writerB.tools.locationManage({ action: 'list' })).toEqual(emptyLocations);

        // The chapter body is only available from `get`, on the same session.
        expect(await writerA.executeTool('chapterManage', { action: 'get', id: '1' })).toEqual({
            chapter: { id: '1', title: 'Arrival', summary: 'They land.', status: 'planned' },
            content: 'The ship settles.',
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });

        // A reset is a clean start for every store, including the id sequences.
        writerA.reset();

        expect(await writerA.tools.profileManage({ action: 'list' })).toEqual(emptyProfiles);
        expect(await writerA.tools.chapterManage({ action: 'list' })).toEqual(emptyChapters);
        expect(await writerA.tools.locationManage({ action: 'list' })).toEqual(emptyLocations);

        expect(
            await writerA.tools.profileManage({
                action: 'add',
                name: 'After reset',
                description: 'Fresh.'
            })
        ).toEqual({
            profile: { id: '1', name: 'After reset', description: 'Fresh.', traits: [], notes: '' },
            counts: { total: 1 }
        });
        expect(
            await writerA.tools.chapterManage({
                action: 'add',
                title: 'After reset',
                summary: 'Fresh.'
            })
        ).toEqual({
            chapter: { id: '1', title: 'After reset', summary: 'Fresh.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
        expect(
            await writerA.tools.locationManage({
                action: 'add',
                name: 'After reset',
                description: 'Fresh.'
            })
        ).toEqual({
            location: { id: '1', name: 'After reset', description: 'Fresh.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('reserves the names for configured tools, plugins, and dynamic creation', () => {
        const names = ['profileManage', 'chapterManage', 'locationManage'];

        for (const name of names) {
            const custom = tool({ description: 'Mine.', tags: ['records'], execute: () => 'ok' });

            expect(() =>
                harness({
                    agents: { writer: brain(scripted([answer('hi')])) },
                    tools: { [name]: custom },
                    presets: false
                })
            ).toThrow(`Tool "${name}" is reserved by the harness.`);

            expect(() =>
                harness({
                    agents: { writer: brain(scripted([answer('hi')])) },
                    presets: false,
                    plugins: [
                        {
                            name: 'claim',
                            setup: (api) => {
                                api.addTool(name, {
                                    description: 'Mine.',
                                    tags: ['records'],
                                    execute: () => 'ok'
                                });
                            }
                        }
                    ]
                })
            ).toThrow(`Tool "${name}" is reserved by the harness.`);

            const writer = quiet(brain(scripted([answer('hi')])));

            expect(() =>
                writer.createTool({ name, description: 'Mine.', tags: ['records'], source: 'return 1;' })
            ).toThrow(`Tool name "${name}" is reserved by the harness.`);

            // toolCreate's reservation check is case-insensitive.
            const capitalised = name.charAt(0).toUpperCase() + name.slice(1);

            expect(() =>
                writer.createTool({
                    name: capitalised,
                    description: 'Mine.',
                    tags: ['records'],
                    source: 'return 1;'
                })
            ).toThrow(`Tool name "${capitalised}" is reserved by the harness.`);
        }

        // The quiet registry is exactly the core set, in order.
        const writer = quiet(brain(scripted([answer('hi')])));
        expect(Object.keys(writer.tools)).toEqual(CORE_ORDER_SUBAGENT);
    });

    it('turns invalid record input into recoverable tool results', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'chapterManage', '{"action":"add","title":"No summary"}'),
                callTool('c2', 'profileManage', '{"action":"update","id":"99","name":"Nobody"}'),
                callTool('c3', 'locationManage', '{"action":"add","name":"Nowhere"}'),
                answer('recovered')
            ])
        );
        const writer = quiet(entry);

        const message = await writer('try');

        expect(message.content).toBe('recovered');

        const toolMessages = entry.messages.filter((line) => line.role === 'tool');
        expect(toolMessages.map((entry) => entry.content)).toEqual([
            'Tool "chapterManage" failed: chapterManage "add" requires a non-empty "summary" string.',
            'Tool "profileManage" failed: profileManage has no profile with id "99".',
            'Tool "locationManage" failed: locationManage "add" requires a non-empty "description" string.'
        ]);

        // Nothing was created by the failed calls.
        expect(await writer.tools.profileManage({ action: 'list' })).toEqual(emptyProfiles);
        expect(await writer.tools.chapterManage({ action: 'list' })).toEqual(emptyChapters);
        expect(await writer.tools.locationManage({ action: 'list' })).toEqual(emptyLocations);
    });
});
