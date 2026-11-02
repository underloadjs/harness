// profileManage / chapterManage / locationManage in the harness — declaration,
// turns, sharing, isolation, reset, reservation, and recoverable errors.
//
// These tests sit next to harness() because they pin harness integration, while
// src/core/profile.test.ts, chapter.test.ts, and location.test.ts cover the tool
// implementations:
//   - all three stay registered but are searchable, so they are absent from the
//     first request until toolRequest opens their tags (R9-R11);
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

// Tool results, in the order the model received them. Every scripted turn that
// calls a tool appends one of these, so the tests can pin exact envelopes.
const toolResults = (agent: Agent): string[] =>
    agent.messages.filter((line) => line.role === 'tool').map((line) => line.content);

// A harness with no presets, so the registry is exactly the core tools plus
// whatever a test adds.
const quiet = (entry: Agent, tools: Record<string, any> = {}) =>
    harness({ agents: { writer: entry }, tools, presets: false });

// R9-R11: the record tools are registered and searchable, not declared, so the
// first request only offers the bootstrap plus the session plan.
const CORE_ORDER = [
    'toolRequest',
    'task'
];

// delegate stays primary-only and is declared when the harness has subagents;
// threadFork was demoted with the rest of the runtime set.
const CORE_ORDER_PRIMARY = [...CORE_ORDER, 'delegate'];
const CORE_ORDER_SUBAGENT = [...CORE_ORDER];

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
    it('are searchable and only reach the model after toolRequest opens their tags', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    // One toolRequest is enough: the 'profile' tag opens exactly
                    // profileManage (chapterManage and locationManage have their own
                    // 'chapter' and 'location' tags).
                    callTool('c1', 'toolRequest', '{"tags":["profile"]}'),
                    callTool(
                        'c2',
                        'profileManage',
                        '{"action":"add","name":"Elena","description":"A cartographer."}'
                    ),
                    answer('added')
                ],
                seen
            )
        );
        const writer = quiet(entry);

        // Registered and searchable, never declared on their own.
        expect(writer.tools.profileManage.visibility).toBe('searchable');
        expect(writer.tools.chapterManage.visibility).toBe('searchable');
        expect(writer.tools.locationManage.visibility).toBe('searchable');

        await writer('remember Elena');

        // The first request is bootstrap-only; the second carries the one record
        // tool the 'profile' tag opened (chapterManage and locationManage have their
        // own tags).
        expect(declaredNames(seen[0])).toEqual(CORE_ORDER_SUBAGENT);
        expect(declaredNames(seen[1])).toEqual([...CORE_ORDER_SUBAGENT, 'profileManage']);

        // The add the model asked for, verbatim.
        expect(toolResults(entry)[1]).toBe(`{"profile":${JSON.stringify(ELENA)},"counts":{"total":1}}`);
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
                    // Enablement is harness-wide: one toolRequest is enough for the
                    // researcher's later call to be accepted.
                    callTool('c0', 'toolRequest', '{"tags":["profile"]}'),
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

        // Configured tools precede the harness-owned set; delegate is
        // primary-only, and threadFork was demoted with the runtime set.
        // `peek` was configured after the baseline, so it follows it.
        expect(declaredNames(writerSeen[0])).toEqual([...CORE_ORDER_PRIMARY, 'peek']);
        // The researcher's run starts after the enablement, so profileManage is
        // declared for it too: configured tools first, then the record tool the
        // 'profile' tag opened.
        expect(declaredNames(researcherSeen[0])).toEqual([
            ...CORE_ORDER_SUBAGENT,
            'peek',
            'profileManage'
        ]);
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
        await writerA.executeTool('locationManage', { action: 'add', name: 'Harbour', description: 'A port.' });

        // A second harness (a second session) sees none of it.
        expect(await writerB.executeTool('profileManage', { action: 'list' })).toEqual(emptyProfiles);
        expect(await writerB.executeTool('chapterManage', { action: 'list' })).toEqual(emptyChapters);
        expect(await writerB.executeTool('locationManage', { action: 'list' })).toEqual(emptyLocations);

        // The chapter body is only available from `get`, on the same session.
        expect(await writerA.executeTool('chapterManage', { action: 'get', id: '1' })).toEqual({
            chapter: { id: '1', title: 'Arrival', summary: 'They land.', status: 'planned' },
            content: 'The ship settles.',
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });

        // A reset is a clean start for every store, including the id sequences.
        writerA.reset();

        expect(await writerA.executeTool('profileManage', { action: 'list' })).toEqual(emptyProfiles);
        expect(await writerA.executeTool('chapterManage', { action: 'list' })).toEqual(emptyChapters);
        expect(await writerA.executeTool('locationManage', { action: 'list' })).toEqual(emptyLocations);

        expect(
            await writerA.executeTool('profileManage', {
                action: 'add',
                name: 'After reset',
                description: 'Fresh.'
            })
        ).toEqual({
            profile: { id: '1', name: 'After reset', description: 'Fresh.', traits: [], notes: '' },
            counts: { total: 1 }
        });
        expect(
            await writerA.executeTool('chapterManage', {
                action: 'add',
                title: 'After reset',
                summary: 'Fresh.'
            })
        ).toEqual({
            chapter: { id: '1', title: 'After reset', summary: 'Fresh.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
        expect(
            await writerA.executeTool('locationManage', {
                action: 'add',
                name: 'After reset',
                description: 'Fresh.'
            })
        ).toEqual({
            location: { id: '1', name: 'After reset', description: 'Fresh.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('lets configured tools, plugins, and dynamic creation replace the record names', async () => {
        const names = ['profileManage', 'chapterManage', 'locationManage'];

        for (const name of names) {
            const custom = tool({ description: 'Mine.', tags: ['records'], execute: () => 'ok' });

            const configured = harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                tools: { [name]: custom },
                presets: false
            });
            expect(configured.tools[name]).not.toBe(custom);
            expect(configured.tools[name].description).toBe('Mine.');

            const plugin = harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                presets: false,
                plugins: [
                    {
                        name: 'claim',
                        setup: (api) => {
                            api.addTool(name, {
                                description: 'Mine.',
                                tags: ['records'],
                                execute: () => 'plugin'
                            });
                        }
                    }
                ]
            });
            await expect(plugin.executeTool(name, {})).resolves.toBe('plugin');

            const writer = quiet(brain(scripted([answer('hi')])));
            writer.createTool({
                name,
                description: 'Mine.',
                tags: ['records'],
                source: 'return 1;'
            });
            await expect(writer.executeTool(name, {})).resolves.toBe(1);
        }

        // The quiet registry is the harness-owned set in registration order: the
        // runtime tools (including the demoted, searchable ones) plus the
        // conditional toolCancel baseline. delegate and actionRequest are absent
        // because this harness has no subagents.
        const writer = quiet(brain(scripted([answer('hi')])));
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

    it('turns invalid record input into recoverable tool results', async () => {
        const entry = brain(
            scripted([
                // The trio is searchable, so the model opens the tags first; the
                // three invalid calls then exercise the tools themselves.
                callTool('c0', 'toolRequest', '{"tags":["chapter","profile","location"]}'),
                callTool('c1', 'chapterManage', '{"action":"add","title":"No summary"}'),
                callTool('c2', 'profileManage', '{"action":"update","id":"99","name":"Nobody"}'),
                callTool('c3', 'locationManage', '{"action":"add","name":"Nowhere"}'),
                answer('recovered')
            ])
        );
        const writer = quiet(entry);

        const message = await writer('try');

        expect(message.content).toBe('recovered');

        const results = toolResults(entry);
        expect(results[1]).toBe(
            'Tool "chapterManage" failed: chapterManage "add" requires a non-empty "summary" string.'
        );
        expect(results[2]).toBe('Tool "profileManage" failed: profileManage has no profile with id "99".');
        expect(results[3]).toBe(
            'Tool "locationManage" failed: locationManage "add" requires a non-empty "description" string.'
        );

        // Nothing was created by the failed calls.
        expect(await writer.executeTool('profileManage', { action: 'list' })).toEqual(emptyProfiles);
        expect(await writer.executeTool('chapterManage', { action: 'list' })).toEqual(emptyChapters);
        expect(await writer.executeTool('locationManage', { action: 'list' })).toEqual(emptyLocations);
    });
});
