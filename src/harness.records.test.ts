// profiles / chapters / locations (and the `records` engine behind them) in the
// harness — declaration, turns, sharing, isolation, reset, and recoverable errors.
//
// These tests sit next to harness() because they pin harness integration, while
// src/core/records.test.ts covers the engine the wrappers route to (the per-store
// modules and their test files are gone — records-engine T3):
//   - all three stay registered but are searchable, so they are absent from the
//     first request until toolRequest opens their tags (R9-R11);
//   - state persists across harness calls and is shared by every agent;
//   - a second harness starts empty; reset() clears all three stores and restarts
//     their id sequences;
//   - configured tools, plugins, and dynamic creation cannot claim the names;
//   - invalid input becomes a readable, recoverable tool result.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The entries are read as TEXT by the F12 construction check below, so the assertion is
// about the shipped source, not about a fixture copy of it.
import { readFile } from 'node:fs/promises';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessStateChangeEvent,
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
    'tasks'
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
// THE FROZEN CLOCK. Every store timestamp comes from Date in src/core/records.ts, so
// pinning it gives each `updatedAt` ONE exact expected value (the same policy
// src/harness.task.test.ts uses: `toFake: ['Date']` leaves the microtask queue real).
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(EPOCH_ISO));
});

afterEach(() => {
    vi.useRealTimers();
});

const page = (offset = 0, limit = 20, hasMore = false) => ({ offset, limit, hasMore });

const emptyProfiles = { profiles: [], counts: { total: 0 }, page: page() };
const emptyChapters = {
    chapters: [],
    counts: { total: 0, planned: 0, draft: 0, complete: 0 },
    page: page()
};
const emptyLocations = { locations: [], counts: { total: 0 }, page: page() };

// The one profile every add in this file creates. R3 gives every record the engine's
// concurrency fields, so a stored entry now carries its content revision plus attribution
// — read from the caller's context, never from arguments. This file pins no clock, so
// `updatedAt` is matched by type; the rest are exact.
// The engine serializes an entry in its CANONICAL key order: `id`, the declared fields,
// `rev`, then the attribution triple in its own order (`updatedBy`, `updatedThreadId`,
// `updatedAt`) — src/core/records.ts `readStoredEntry`/`copyEntry` rebuild that order on
// every read. Line ~162 below compares a tool result as JSON TEXT, so this fixture's key
// ORDER is part of the expectation, not just its keys.
const ELENA_BASE = {
    id: '1',
    name: 'Elena',
    description: 'A cartographer.',
    traits: [],
    notes: '',
    rev: 1
};

// The MODEL path (a turn inside `agent:writer`), so the writer's thread is recorded too.
const ELENA = {
    ...ELENA_BASE,
    updatedBy: 'writer',
    updatedThreadId: 'agent:writer',
    updatedAt: EPOCH_ISO
};

// The HOST path (`harness.executeTool`), which carries an agent but no thread.
const ELENA_HOST = { ...ELENA_BASE, updatedBy: 'writer', updatedAt: EPOCH_ISO };

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
                        'profiles',
                        '{"action":"add","name":"Elena","description":"A cartographer."}'
                    ),
                    answer('added')
                ],
                seen
            )
        );
        const writer = quiet(entry);

        // Registered and searchable, never declared on their own.
        expect(writer.tools.profiles.visibility).toBe('searchable');
        expect(writer.tools.chapters.visibility).toBe('searchable');
        expect(writer.tools.locations.visibility).toBe('searchable');

        await writer('remember Elena');

        // The first request is bootstrap-only; the second carries the one record
        // tool the 'profile' tag opened (chapterManage and locationManage have their
        // own tags).
        expect(declaredNames(seen[0])).toEqual(CORE_ORDER_SUBAGENT);
        // `records` rides along at the 1-point description rung (see the note at the top
        // of this file): the query opened `profiles` by tag and `records` by description.
        expect(declaredNames(seen[1])).toEqual([...CORE_ORDER_SUBAGENT, 'profiles', 'records']);

        // The add the model asked for, verbatim.
        expect(toolResults(entry)[1]).toBe(`{"profile":${JSON.stringify(ELENA)},"counts":{"total":1}}`);
    });

    it('share one store of each kind with every agent in the same harness', async () => {
        const writerSeen: HarnessStreamRequest[] = [];
        const researcherSeen: HarnessStreamRequest[] = [];

        const researcher = brain(
            scripted(
                [callTool('r1', 'profiles', '{"action":"list"}'), answer('saw the profiles')],
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
                        'profiles',
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
        // The researcher's run starts after the enablement, so the record tools the
        // 'profile' query opened are declared for it too: configured tools first, then
        // `profiles` (exact tag), then `records` (description rung, see the note above).
        expect(declaredNames(researcherSeen[0])).toEqual([
            ...CORE_ORDER_SUBAGENT,
            'peek',
            'profiles',
            'records'
        ]);
    });

    it('keeps records across calls, isolates harnesses, and clears on reset', async () => {
        const writerA = quiet(brain(scripted([answer('hi')])));
        const writerB = quiet(brain(scripted([answer('hi')])));

        // Separate factory instances per harness: not the same tool objects.
        expect(writerA.tools.profiles).not.toBe(writerB.tools.profiles);
        expect(writerA.tools.chapters).not.toBe(writerB.tools.chapters);
        expect(writerA.tools.locations).not.toBe(writerB.tools.locations);

        // The host-side executeTool path mutates the same session stores.
        await writerA.executeTool('profiles', {
            action: 'add',
            name: 'Elena',
            description: 'A cartographer.'
        });
        await writerA.executeTool('chapters', {
            action: 'add',
            title: 'Arrival',
            summary: 'They land.',
            content: 'The ship settles.'
        });
        await writerA.executeTool('locations', { action: 'add', name: 'Harbour', description: 'A port.' });

        // A second harness (a second session) sees none of it.
        expect(await writerB.executeTool('profiles', { action: 'list' })).toEqual(emptyProfiles);
        expect(await writerB.executeTool('chapters', { action: 'list' })).toEqual(emptyChapters);
        expect(await writerB.executeTool('locations', { action: 'list' })).toEqual(emptyLocations);

        // The chapter body is only available from `get`, on the same session — and the
        // id is '2', because ONE counter numbers every collection (F3): the profile above
        // took 1, so the chapter added next is 2 and the location after it is 3.
        expect(await writerA.executeTool('chapters', { action: 'get', id: '2' })).toEqual({
            chapter: {
                id: '2',
                title: 'Arrival',
                summary: 'They land.',
                status: 'planned',
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            content: 'The ship settles.',
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });

        // A reset is a clean start for every store, including the id sequences.
        writerA.reset();

        expect(await writerA.executeTool('profiles', { action: 'list' })).toEqual(emptyProfiles);
        expect(await writerA.executeTool('chapters', { action: 'list' })).toEqual(emptyChapters);
        expect(await writerA.executeTool('locations', { action: 'list' })).toEqual(emptyLocations);

        expect(
            await writerA.executeTool('profiles', {
                action: 'add',
                name: 'After reset',
                description: 'Fresh.'
            })
        ).toEqual({
            profile: {
                id: '1',
                name: 'After reset',
                description: 'Fresh.',
                traits: [],
                notes: '',
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            counts: { total: 1 }
        });
        expect(
            await writerA.executeTool('chapters', {
                action: 'add',
                title: 'After reset',
                summary: 'Fresh.'
            })
        ).toEqual({
            chapter: {
                // The counter is the STORE's (F3), so a reset restarts ONE sequence:
                // the profile above took 1, this chapter is 2, the location after it 3.
                id: '2',
                title: 'After reset',
                summary: 'Fresh.',
                status: 'planned',
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
        expect(
            await writerA.executeTool('locations', {
                action: 'add',
                name: 'After reset',
                description: 'Fresh.'
            })
        ).toEqual({
            location: {
                id: '3',
                name: 'After reset',
                description: 'Fresh.',
                notes: '',
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            counts: { total: 1 }
        });
    });

    it('lets configured tools, plugins, and dynamic creation replace the record names', async () => {
        const names = ['profiles', 'chapters', 'locations'];

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
            'records',

            'tasks',
            'profiles',
            'chapters',
            'locations',
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
                callTool('c1', 'chapters', '{"action":"add","title":"No summary"}'),
                callTool('c2', 'profiles', '{"action":"update","id":"99","name":"Nobody"}'),
                callTool('c3', 'locations', '{"action":"add","name":"Nowhere"}'),
                answer('recovered')
            ])
        );
        const writer = quiet(entry);

        const message = await writer('try');

        expect(message.content).toBe('recovered');

        const results = toolResults(entry);
        expect(results[1]).toBe(
            'Tool "chapters" failed: invalid-field: chapters "entries[0]" needs "summary" to add a chapter, or an existing "id" to change one.'
        );
        expect(results[2]).toBe('Tool "profiles" failed: unknown-record: profiles has no profile with id "99".');
        expect(results[3]).toBe(
            'Tool "locations" failed: invalid-field: locations "entries[0]" needs "description" to add a location, or an existing "id" to change one.'
        );

        // Nothing was created by the failed calls.
        expect(await writer.executeTool('profiles', { action: 'list' })).toEqual(emptyProfiles);
        expect(await writer.executeTool('chapters', { action: 'list' })).toEqual(emptyChapters);
        expect(await writer.executeTool('locations', { action: 'list' })).toEqual(emptyLocations);
    });
});

// ---------------------------------------------------------------------------
// F12 / T7 — one notification per logical write, by construction.
//
// The retired design risked TWO `tool_execute` notifications for one model action: if a
// wrapper performed its write by calling `records` through the tool bus, the bus fired
// once for the wrapper and again for the engine call. The five entries are written so
// that cannot happen — one literal schema, then ONE routed call to
// `context.harness.runtime.executeRecords(<its own name>, context)`. Two independent
// checks: the source shape of every entry (the construction), and what one live call
// actually produces (the notification).
// ---------------------------------------------------------------------------
describe('record wrappers call the engine exactly once (F12)', () => {
    const ENTRIES = ['records', 'tasks', 'chapters', 'profiles', 'locations'] as const;
    const NAME_EXPORT: Record<string, string> = {
        records: 'RECORDS_NAME',
        tasks: 'TASKS_NAME',
        chapters: 'CHAPTERS_NAME',
        profiles: 'PROFILES_NAME',
        locations: 'LOCATIONS_NAME'
    };

    it('gives every entry exactly one routed engine call and no tool-bus call', async () => {
        for (const name of ENTRIES) {
            const text = await readFile(
                new URL(`./tools/runtime/${name}.tool.ts`, import.meta.url),
                'utf8'
            );

            // ONE call site, addressed by the routed door, naming ITS OWN tool — the
            // wrapper carries no logic the engine would have to re-derive.
            expect(text.match(/runtime\.executeRecords\([A-Z_]+_NAME, context\)/g) ?? []).toHaveLength(1);
            expect(text).toContain(`runtime.executeRecords(${NAME_EXPORT[name]}, context)`);

            // `callTool` is the second door: a wrapper that used it would emit a second
            // notification for the same write (and, in worker mode, bypass the route).
            expect(text.includes('callTool')).toBe(false);
        }
    });

    it('routes one engine call per wrapper invocation and emits one notification', async () => {
        const events: HarnessStateChangeEvent[] = [];
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            // The persistence plane: `report.stateChange` is what a host subscribes to, and
            // F12's question is exactly how many events THAT observer sees per write.
            report: { stateChange: (event) => events.push(event) }
        });

        // Spy the routed door itself: the ONLY way a wrapper can reach the store.
        const runtime = writer.runtime as unknown as {
            executeRecords: (name: string, context: unknown) => Promise<unknown>;
        };
        const engine = runtime.executeRecords;
        const engineCalls: string[] = [];

        runtime.executeRecords = (name: string, context: unknown) => {
            engineCalls.push(name);

            return engine(name, context);
        };

        const CASES: Array<[string, Record<string, unknown>]> = [
            ['tasks', { tasks: [{ text: 'one' }] }],
            ['profiles', { action: 'add', name: 'Elena', description: 'A cartographer.' }],
            ['chapters', { action: 'add', title: 'Arrival', summary: 'They land.' }],
            ['locations', { action: 'add', name: 'Harbour', description: 'A port.' }],
            // The engine surface itself: same route, named by its own tool.
            ['records', { collection: 'tasks', entries: [{ text: 'through the engine' }] }]
        ];

        for (const [name, parameters] of CASES) {
            events.length = 0;
            engineCalls.length = 0;

            await writer.executeTool(name, parameters);

            expect(engineCalls).toEqual([name]);
            expect(events).toEqual([{ type: 'state_change', reason: 'tool_execute', tool: name }]);
        }
    });
});
