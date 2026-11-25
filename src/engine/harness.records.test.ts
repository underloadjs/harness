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
// F7-4's byte pins below are stated in the SAME currency the delivery guard bills in: the
// escaped payload of the exact string `serialize()` hands `boundDelivery` (./harness.ts:1369).
import { modelPayloadBytes } from './core/payload-bytes';
import { MODEL_TOOL_RESULT_BUDGET_BYTES } from './core/result-budget';
import { agent, harness, tool } from './index';
import type {
    Agent,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';

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
            'knowledge',
            'agentManage',
            'agentResult',
            'threadFork',
            'sleep',
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
// R6 / R7 — the two additions to the read surface, exercised through the PUBLIC tool
// surface rather than the engine. A wrapper's schema is `additionalProperties: false`,
// so a schema that forgot a new engine control would strand it silently: `records` must
// accept `describe` and `where`, the four list-capable wrappers must accept `where`, and
// the answers must be the engine's, not a wrapper invention.
// ---------------------------------------------------------------------------
describe('record tools read surface: describe, the bare name list, and where', () => {
    it('T7.1: a wrapper list accepts where and counts the filtered set', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        const planned = (await writer.executeTool('chapters', {
            action: 'add',
            title: 'Arrival',
            summary: 'They land.'
        })) as { chapter: { id: string } };
        await writer.executeTool('chapters', {
            action: 'add',
            title: 'Middle',
            summary: 'The turn.',
            status: 'draft'
        });

        // Only the draft survives the filter, and the FACETS move with it: `planned: 0`
        // while a planned chapter really exists, which is R7's whole point.
        expect(
            await writer.executeTool('chapters', { action: 'list', where: { status: 'draft' } })
        ).toEqual({
            chapters: [
                {
                    id: '2',
                    title: 'Middle',
                    summary: 'The turn.',
                    status: 'draft',
                    rev: 1,
                    updatedBy: 'writer',
                    updatedAt: EPOCH_ISO
                }
            ],
            counts: { total: 1, planned: 0, draft: 1, complete: 0 },
            page: page()
        });

        // An unfiltered list keeps the whole-collection counts (stop-condition 5).
        expect(await writer.executeTool('chapters', { action: 'list' })).toEqual({
            chapters: [
                {
                    id: '1',
                    title: 'Arrival',
                    summary: 'They land.',
                    status: 'planned',
                    rev: 1,
                    updatedBy: 'writer',
                    updatedAt: EPOCH_ISO
                },
                {
                    id: '2',
                    title: 'Middle',
                    summary: 'The turn.',
                    status: 'draft',
                    rev: 1,
                    updatedBy: 'writer',
                    updatedAt: EPOCH_ISO
                }
            ],
            counts: { total: 2, planned: 1, draft: 1, complete: 0 },
            page: page()
        });

        // `tasks` forwards it too, and a field the wrapper schema names is filterable
        // through the wrapper as well as through `records`.
        const seeded = (await writer.executeTool('tasks', {
            tasks: [{ text: 'Open' }, { text: 'Closed' }, { text: 'Also open' }]
        })) as { tasks: Array<{ id: string }> };

        const closedId = seeded.tasks[1].id;

        await writer.executeTool('tasks', {
            tasks: [{ id: closedId, completed: true }],
            expects: [{ id: closedId, rev: 1 }]
        });

        const openOnly = (await writer.executeTool('tasks', {
            where: { completed: false },
            limit: 1
        })) as { tasks: Array<{ text: string }>; counts: Record<string, number>; page: Record<string, unknown> };

        expect(openOnly.tasks.map((task) => task.text)).toEqual(['Open']);
        // The filtered set is two records, and the facet complement is computed over it.
        expect(openOnly.counts).toEqual({ total: 2, completed: 0, pending: 2 });
        // `tasks` declares no sortable field, so an offset page there still carries only
        // `nextOffset` (R2's rule is conditional on the collection).
        expect(openOnly.page).toEqual({ offset: 0, limit: 1, hasMore: true, nextOffset: 1 });

        // A field the collection does not declare is refused by the ENGINE, through the
        // wrapper, naming the key and the fields that do exist.
        await expect(
            writer.executeTool('chapters', { action: 'list', where: { body: 'x' } })
        ).rejects.toThrow(
            'chapters "where" has no field "body"; filterable fields: title, summary, content, status, order.'
        );
    });

    it('T2.1: an offset page of the sortable built-in carries nextAfterId as the maximum id on it', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        // `order` is chapters' sortable field, so the page order and the id order differ
        // on the very first built-in collection.
        const orders = [30, 10, 40, 20];

        for (const order of orders) {
            await writer.executeTool('chapters', {
                action: 'add',
                title: `C${order}`,
                summary: 's',
                order
            });
        }

        // Page order by `order`: ids 2 (10), 4 (20), 1 (30), 3 (40). Cut at 3, the page
        // ENDS at id 1 while the largest id on it is 4 — the cursor must be 4.
        const first = (await writer.executeTool('chapters', { action: 'list', limit: 3 })) as {
            chapters: Array<{ id: string }>;
            page: { nextAfterId?: string; nextOffset?: number };
        };

        expect(first.chapters.map((chapter) => chapter.id)).toEqual(['2', '4', '1']);
        expect(first.page).toEqual({ offset: 0, limit: 3, hasMore: true, nextOffset: 3, nextAfterId: '4' });

        // Resuming keyset from that cursor repeats nothing the page already showed — but
        // the one record the page had NOT reached (id 3, which sorts last yet carries a
        // smaller id) is behind the cursor and is therefore skipped. That asymmetry is
        // exactly why T2.2's reworded `afterId` text forbids mixing the two modes inside
        // one walk and calls the per-mode walk the complete one: `nextAfterId` on an
        // offset page is the only cursor that cannot REPEAT a record, not a promise that a
        // mid-walk switch is lossless.
        const resumed = (await writer.executeTool('records', {
            collection: 'chapters',
            afterId: first.page.nextAfterId as string,
            limit: 3
        })) as { entries: Array<{ id: string }>; page: Record<string, unknown> };

        expect(resumed.entries).toEqual([]);
        expect(resumed.page).toEqual({ offset: 4, limit: 3, hasMore: false, afterId: '4' });

        // The complete walk in ONE mode, by offset, still sees all four in page order.
        const complete: string[] = [];
        let offset = 0;

        for (let guard = 0; guard < 8; guard += 1) {
            const step = (await writer.executeTool('chapters', {
                action: 'list',
                offset,
                limit: 2
            })) as { chapters: Array<{ id: string }>; page: { hasMore: boolean; nextOffset?: number } };

            complete.push(...step.chapters.map((chapter) => chapter.id));

            if (!step.page.hasMore) break;

            offset = step.page.nextOffset as number;
        }

        expect(complete).toEqual(['2', '4', '1', '3']);
    });

    it('T6.1/T6.2: records reads a defined spec back, and a bare call lists the collections', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        await writer.executeTool('records', {
            define: {
                name: 'probeg1',
                maxRecords: 7,
                fields: [
                    { key: 'title', type: 'text', required: true, maxLength: 42 },
                    { key: 'body', type: 'text', maxLength: 500, getOnly: true },
                    { key: 'rank', type: 'integer', sortable: true, max: 999 },
                    { key: 'kind', type: 'enum', values: ['note', 'task'], count: true }
                ]
            }
        });

        expect(await writer.executeTool('records', { collection: 'probeg1', describe: true })).toEqual({
            entries: [],
            counts: { total: 0, note: 0, task: 0 },
            page: page(),
            storeRev: 0,
            collection: 'probeg1',
            definition: {
                name: 'probeg1',
                fields: [
                    { key: 'title', type: 'text', required: true, maxLength: 42 },
                    { key: 'body', type: 'text', maxLength: 500, getOnly: true },
                    { key: 'rank', type: 'integer', sortable: true, max: 999 },
                    { key: 'kind', type: 'enum', values: ['note', 'task'], count: true }
                ],
                maxRecords: 7,
                // The engine default the caller omitted (64 KiB — F1-6 had lowered it to
                // 24,576 and F7-4 restored it; delivery is clamped to 32,768 separately).
                responseBudgetBytes: 65_536
            }
        });

        // A bare call answers with the name list instead of the unknown-collection error.
        expect(await writer.executeTool('records', {})).toEqual({
            entries: [],
            counts: { total: 5 },
            page: page(),
            storeRev: 0,
            collections: ['chapters', 'locations', 'probeg1', 'profiles', 'tasks']
        });
    });

    // -----------------------------------------------------------------------
    // R-0010 — the tool entry point used to consume `define` first and THROW AWAY the
    // `collection` riding beside it: the stress test sent
    // `{ collection: "unicode", define: { name: "verifyG", … } }`, got a success, and read
    // back `"collection": "verifyG"` — not the name it sent. The engine's own guard calls
    // that pair ambiguous, so the enforced contract is refusal, and it now holds here too.
    // -----------------------------------------------------------------------
    const VERIFY_G = {
        name: 'verifyG',
        fields: [{ key: 'note', type: 'text', maxLength: 40 }]
    };

    // The name list of an untouched session, which is the control every case below re-reads.
    const BUILT_IN_LIST = {
        entries: [],
        counts: { total: 4 },
        page: page(),
        storeRev: 0,
        collections: ['chapters', 'locations', 'profiles', 'tasks']
    };

    it('0010: the records tool refuses define beside a collection and registers nothing', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        expect(await writer.executeTool('records', {})).toEqual(BUILT_IN_LIST);

        // Acceptance 1: the same wording the engine guard has always used, from the door
        // that actually runs, and ahead of any collection lookup.
        await expect(
            writer.executeTool('records', { collection: 'unicode', define: VERIFY_G })
        ).rejects.toThrow(
            'invalid-input: records "define" registers a NEW collection, so it takes no "collection" beside it.'
        );

        // Acceptance 2: the refused call registered nothing, so the list is what it was and
        // the caller's `unicode` typo is still reported as the typo it is.
        expect(await writer.executeTool('records', {})).toEqual(BUILT_IN_LIST);
        await expect(writer.executeTool('records', { collection: 'unicode' })).rejects.toThrow(
            'unknown-collection: records has no collection "unicode"; defined collections: tasks, chapters, profiles, locations.'
        );
    });

    it('0010: define on its own through the tool still registers, exactly as before', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        const defined = (await writer.executeTool('records', { define: VERIFY_G })) as {
            collection: string;
            storeRev: number;
        };

        expect(defined.collection).toBe('verifyG');
        // A `define` writes no record, so it moves no collection's revision (F12's quiet
        // notification), and the name list is the only place it lands.
        expect(defined.storeRev).toBe(0);
        expect(await writer.executeTool('records', {})).toEqual({
            entries: [],
            counts: { total: 5 },
            page: page(),
            storeRev: 0,
            collections: ['chapters', 'locations', 'profiles', 'tasks', 'verifyG']
        });
    });

    // The one question 0010 left UNCONFIRMED was whether a wrapper's JSON schema admits an
    // undeclared `define` at all — i.e. whether the engine guard at
    // src/core/records.ts:2902 is live or dead. Settled by this case: `tasks.tool.ts:170`
    // sets `additionalProperties: false`, that schema never declares `define`, and
    // core/schema-validation.ts:208 enforces the key on every call path
    // (`executeTool` included — harness.ts:11226). So a TOOL-surface wrapper call dies
    // before the engine runs, and the guard is reached only by a caller that enters the
    // engine directly — pinned in src/core/records.test.ts, same wording either way.
    it('0010: a wrapper schema refuses an undeclared define before the engine can merge it', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        await expect(
            writer.executeTool('tasks', { tasks: [{ text: 'Ride' }], define: VERIFY_G })
        ).rejects.toThrow('must not include the additional property "define".');

        expect(await writer.executeTool('records', {})).toEqual(BUILT_IN_LIST);
    });

    // Acceptance 3, as a check that survives a forgotten regeneration: the entry states the
    // enforced rule in the description a model reads, and the generated manifest carries the
    // same sentence. (`scripts/generate-tool-manifest.mjs --check` is the build-time twin of
    // this assertion; it exits 0 on this tree.)
    it('0010: the records description states the rule, and the manifest carries it verbatim', async () => {
        const RULE =
            '`define` beside a `collection` is an ERROR, never a merge that discards your `collection`';

        const entry = await readFile(new URL('./tools/runtime/records.tool.ts', import.meta.url), 'utf8');
        const manifest = await readFile(new URL('./core/tool-manifest.ts', import.meta.url), 'utf8');

        expect(entry).toContain(RULE);
        expect(manifest).toContain(RULE);
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

// ---------------------------------------------------------------------------
// 0008 — a multi-record mutation names the ids it wrote, at the TOOL entry point.
//
// src/core/records.test.ts pins the engine rule (one id list per affected-record list, each
// emitted only when THAT list has more than one entry, whatever `limit` says); this file
// pins the two things only a harness call can show — the un-wrapped `records` tool a model
// actually reaches for, and the `tasks` batch wrapper's historical envelope. The live
// failure was `records { entries: [a, b], limit: 1 }` answering with one unrelated page row,
// so every case below keeps the documented cheap recipe (`limit: 1`) and asserts the exact
// ids. `TaskResult`/`RecordsResult` (src/types, another pass owns that file) do not declare
// the new keys yet, so each case narrows the result it reads.
// ---------------------------------------------------------------------------
describe('a multi-record mutation names the ids it wrote (issue 0008)', () => {
    // The engine's canonical entry order, with the harness caller stamped in: `executeTool`
    // is an identified caller, so a stored record carries `updatedBy` (and no thread,
    // because the host path has none). The frozen clock gives `updatedAt` one value.
    const taskRow = (id: string, text: string, rev: number, completed = false) => ({
        id,
        text,
        completed,
        rev,
        updatedBy: 'writer',
        updatedAt: EPOCH_ISO
    });

    it('names both ids a two-add `records` batch minted, beside a `limit: 1` page', async () => {
        const writer = quiet(brain(scripted([answer('unused')])));

        const added = (await writer.executeTool('records', {
            collection: 'tasks',
            entries: [{ text: 'One' }, { text: 'Two' }],
            limit: 1
        })) as Record<string, unknown>;

        // The whole envelope, because the fix must not disturb anything beside the new key:
        // the page is still the one row `limit` allowed, `entry` stays absent for two
        // records, and the sibling lists stay out when they describe nothing.
        expect(added).toEqual({
            entries: [taskRow('1', 'One', 1)],
            counts: { total: 2, completed: 0, pending: 2 },
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            storeRev: 2,
            oldestAvailableRev: 1,
            addedIds: ['1', '2']
        });

        // Two patches, in caller order under the `limit: 1` recipe — the other half of the
        // issue, which had no `entry` and no id list either.
        const patched = (await writer.executeTool('records', {
            collection: 'tasks',
            entries: [
                { id: '1', completed: true },
                { id: '2', completed: true }
            ],
            expects: [
                { id: '1', rev: 1 },
                { id: '2', rev: 1 }
            ],
            limit: 1
        })) as Record<string, unknown>;

        expect(patched).toEqual({
            entries: [taskRow('1', 'One', 2, true)],
            counts: { total: 2, completed: 2, pending: 0 },
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            storeRev: 4,
            oldestAvailableRev: 1,
            changedIds: ['1', '2']
        });

        // One record still answers with `entry` — that half of the M3 rule is unchanged,
        // because it is what lets an action wrapper answer `add`/`update` with one typed
        // record. What 0012 (R1) reversed is the SUPPRESSION half: `entry` is a convenience
        // for the single-record case, not a reason to withhold a list, so this patch names
        // its id in `changedIds` too. Whole envelope, because the fix must not disturb
        // anything beside the keys it added.
        const single = (await writer.executeTool('records', {
            collection: 'tasks',
            entries: [{ id: '1', text: 'Renamed' }],
            expects: [{ id: '1', rev: 2 }],
            limit: 1
        })) as Record<string, unknown>;

        expect(single).toEqual({
            entries: [taskRow('1', 'Renamed', 3, true)],
            counts: { total: 2, completed: 2, pending: 0 },
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            storeRev: 5,
            oldestAvailableRev: 1,
            entry: taskRow('1', 'Renamed', 3, true),
            changedIds: ['1']
        });
    });

    // 0012 (AC1) at the un-wrapped door: ONE add plus ONE patch. This is the batch the old
    // per-key "more than one" gate left with no id at all — `entry` needs exactly one
    // affected record, and each list was still under its own bar — so the whole envelope is
    // pinned, including the absence of `noopIds` (nothing here was a no-op).
    it('0012: a `records` batch of one add plus one patch names both ids in the envelope', async () => {
        const writer = quiet(brain(scripted([answer('unused')])));

        await writer.executeTool('records', { collection: 'tasks', entries: [{ text: 'One' }] });

        const mixed = (await writer.executeTool('records', {
            collection: 'tasks',
            entries: [{ text: 'Two' }, { id: '1', completed: true }],
            expects: [{ id: '1', rev: 1 }],
            limit: 1
        })) as Record<string, unknown>;

        expect(mixed).toEqual({
            // The page is still the one row `limit` allowed, and that row cannot be the
            // minted record — which is precisely why the receipts exist.
            entries: [taskRow('1', 'One', 2, true)],
            counts: { total: 2, completed: 1, pending: 1 },
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            storeRev: 3,
            oldestAvailableRev: 1,
            changedIds: ['1'],
            addedIds: ['2']
        });
    });

    // 0012 (AC2) at the un-wrapped door: a patch that re-sends the stored value is a
    // success that wrote nothing, and `noopIds` is the only place that fact appears.
    it('0012: a `records` patch that re-sends the stored value names the id in `noopIds` only', async () => {
        const writer = quiet(brain(scripted([answer('unused')])));

        await writer.executeTool('records', { collection: 'tasks', entries: [{ text: 'One' }] });

        const noop = (await writer.executeTool('records', {
            collection: 'tasks',
            entries: [{ id: '1', text: 'One' }],
            expects: [{ id: '1', rev: 1 }],
            limit: 1
        })) as Record<string, unknown>;

        expect(noop).toEqual({
            entries: [taskRow('1', 'One', 1)],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 1, hasMore: false },
            // No event was recorded, so the store revision is exactly where the add left it.
            storeRev: 1,
            oldestAvailableRev: 1,
            noopIds: ['1']
        });
    });

    it('names the ids a `tasks` batch added or changed, and names a one-record batch too', async () => {
        const writer = quiet(brain(scripted([answer('unused')])));

        const twoAdds = (await writer.executeTool('tasks', {
            tasks: [{ text: 'One' }, { text: 'Two' }],
            limit: 1
        })) as Record<string, unknown>;

        // `tasks` is the batch-style wrapper: its page envelope predates the engine, and the
        // new key is the ONLY addition. Note the absence of `oldestAvailableRev` — the floor
        // rides the wrapper only beside `changes` (0011), so this envelope stays as it was.
        expect(twoAdds).toEqual({
            tasks: [taskRow('1', 'One', 1)],
            counts: { total: 2, completed: 0, pending: 2 },
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            storeRev: 2,
            addedIds: ['1', '2']
        });

        const twoPatches = (await writer.executeTool('tasks', {
            tasks: [{ id: '2', completed: true }, { id: '1', completed: true }],
            expects: [
                { id: '2', rev: 1 },
                { id: '1', rev: 1 }
            ],
            limit: 1
        })) as Record<string, unknown>;

        // Caller order again: the batch named 2 first, so `changedIds` starts with it while
        // the page (offset 0) still shows id 1.
        expect(twoPatches).toEqual({
            tasks: [taskRow('1', 'One', 2, true)],
            counts: { total: 2, completed: 2, pending: 0 },
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            storeRev: 4,
            changedIds: ['2', '1']
        });

        const oneAdd = (await writer.executeTool('tasks', { tasks: [{ text: 'Three' }], limit: 1 })) as Record<
            string,
            unknown
        >;

        // Key ORDER included: the wrapper's envelope is pinned byte-for-byte elsewhere, and
        // 0012 (R1) appends the receipt AFTER `entry` — `toWrapperResult` assembles the batch
        // envelope in this order, and a one-record batch now carries a one-element list
        // beside the singular key instead of naming nothing.
        expect(Object.keys(oneAdd)).toEqual(['tasks', 'counts', 'page', 'storeRev', 'entry', 'addedIds']);
        expect(oneAdd.addedIds).toEqual(['3']);
        expect(oneAdd.entry).toEqual(taskRow('3', 'Three', 1));
    });
});

// ---------------------------------------------------------------------------
// F7-4 (2026-11-25) — the delivery cap, measured at the seam that actually bills.
//
// The four built-in collections are sized by a 64 KiB page budget (./core/{task,chapter,
// profile,location}.ts), which is DELIBERATELY above the harness's own limit:
// MODEL_TOOL_RESULT_BUDGET_BYTES, 32,768 payload bytes, over which `boundDelivery` REFUSES a
// JSON result outright — "oversized tool result: … rewrite the call" — rather than cutting it
// (./core/result-budget.ts:557-578, and the harness.ts:196-204 correction). A refused result
// loses the page AND the cursor with it, so the caller cannot even retry its way forward.
//
// What makes "a delivered record answer never exceeds the cap" TRUE is not a smaller budget:
// it is `clampToDeliveryCap` at the engine's delivery seam (./core/records.ts), which trims
// the delivered answer and re-derives its cursors. These are the measurements that pin that —
// through `executeTool`, the host door the server's Tools tab uses (./harness.ts:220-222),
// which runs the SAME guard the model-facing path does.
//
// Byte figures here are `modelPayloadBytes(JSON.stringify(answer))`, the guard's own measure.
// The UTF-8 wire count is smaller (the first page below is 29,894 on the wire and 30,084 in
// the payload), and pinning the smaller number would leave the guard's measure unverified.
// ---------------------------------------------------------------------------
describe('a delivered record answer never crosses the harness delivery cap (F7-4)', () => {
    const deliveredBytes = (answer: unknown): number => modelPayloadBytes(JSON.stringify(answer));

    // ASCII filler, one byte per character, so the byte figures below do not depend on which
    // letter a row was padded with — only on how many characters it holds.
    const filler = (index: number): string => String.fromCharCode(97 + (index % 26));

    it('F7-4: a `tasks` page the 64 KiB budget sized past the cap arrives inside it, cursor and all', async () => {
        const writer = quiet(brain(scripted([])));

        for (let index = 0; index < 20; index += 1) {
            await writer.executeTool('tasks', { tasks: [{ text: `t${index}`.padEnd(3_600, filler(index)) }] });
        }

        // `limit: 100` with a 65,536-byte budget admits ~18 rows of 3,600 characters — twice
        // what the cap holds — so the answer that reaches the guard is the clamp's, not the
        // engine's. It had to survive the guard at all: before the clamp this call THREW.
        const page = (await writer.executeTool('tasks', { limit: 100 })) as Record<string, any>;

        expect(deliveredBytes(page)).toBe(30_084);
        expect(deliveredBytes(page) <= MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(true);
        expect(page.tasks.map((row: Record<string, unknown>) => row.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
        // `counts` is the whole store, not the delivered slice — a caller that sees 8 rows must
        // still be able to tell it asked for 20.
        expect(page.counts).toEqual({ total: 20, completed: 0, pending: 20 });
        expect(page.budgetTruncated).toBe(true);
        // THE MARKER: which bound fired. `budgetTruncated` alone would read like the
        // collection's own 64 KiB budget, and raising that budget would change nothing.
        expect(page.deliveryBudgetBytes).toBe(32_768);
        // The cursor is RE-DERIVED: the engine had `nextOffset: 18`, and a page that resumed
        // there would silently skip rows 9-17.
        expect(page.page).toEqual({
            offset: 0,
            limit: 100,
            hasMore: true,
            nextOffset: 8,
            budgetTruncated: true,
            deliveryBudgetBytes: 32_768
        });
        // Only ROWS were withheld — no delivered row lost a field — so the key that names a
        // field omission stays absent.
        expect('fieldsWithheld' in page).toBe(false);

        // And the truncation is recoverable: walking the cursors the clamp left behind
        // delivers all 20 ids, exactly once each, in three pages of 8, 8 and 4.
        const walk: string[] = [];
        let offset = 0;

        for (;;) {
            const next = (await writer.executeTool('tasks', { limit: 100, offset })) as Record<string, any>;

            expect(deliveredBytes(next) <= MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(true);
            (next.tasks as Record<string, unknown>[]).forEach((row) => walk.push(String(row.id)));

            if (next.page.hasMore !== true) break;

            offset = next.page.nextOffset as number;
        }

        expect(walk).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20']);
    });

    it('F7-4: the `records` tool surface takes the restored 1,024..65,536 budget range again', async () => {
        // AC1 at the DOOR the agent uses, not just inside the engine: F1-6 narrowed this schema
        // to 1,024..24,576, which turned a `define` that used to work (any value from 24,577 to
        // 65,536, including the 64 KiB every built-in collection was born with) into a refusal.
        const writer = quiet(brain(scripted([])));

        for (const responseBudgetBytes of [1_024, 24_577, 32_768, 65_536]) {
            const defined = (await writer.executeTool('records', {
                define: {
                    name: `range${responseBudgetBytes}`,
                    fields: [{ key: 'q', type: 'text' }],
                    responseBudgetBytes
                }
            })) as Record<string, any>;

            // Echoed verbatim — the tool fills in what the caller OMITS, and stores exactly what
            // it accepts (./core/records.test.ts pins both halves at the engine surface).
            expect(defined.definition).toEqual({
                name: `range${responseBudgetBytes}`,
                fields: [{ key: 'q', type: 'text' }],
                maxRecords: 200,
                responseBudgetBytes
            });
        }

        // One past the ceiling is still a REFUSAL, and the message names the ceiling: the range
        // is the caller's request, and a bound it cannot express is a fact about its call.
        await expect(
            writer.executeTool('records', {
                define: { name: 'wide', fields: [{ key: 'q', type: 'text' }], responseBudgetBytes: 65_537 }
            })
        ).rejects.toThrow('$.define.responseBudgetBytes must be <= 65536.');
    });

    it('F7-4: an answer that fits the cap is untouched by it — no marker, no flag, no re-derived cursor', async () => {
        const writer = quiet(brain(scripted([])));

        for (let index = 0; index < 20; index += 1) {
            await writer.executeTool('tasks', { tasks: [{ text: `t${index}`.padEnd(3_600, filler(index)) }] });
        }

        const one = (await writer.executeTool('tasks', { limit: 1 })) as Record<string, any>;

        expect(deliveredBytes(one)).toBe(3_883);
        expect(Object.keys(one)).toEqual(['tasks', 'counts', 'page', 'storeRev']);
        expect(one.page).toEqual({ offset: 0, limit: 1, hasMore: true, nextOffset: 1 });
    });

    it('F7-4: an action wrapper is clamped too, and its keyset cursor names the last row DELIVERED', async () => {
        // `chapters` and `profiles` are ACTION wrappers whose page rides under the collection's
        // plural key (./core/{chapter,profile}.ts), so the clamp reaches them through
        // `wrapper.plural`, not through the engine surface's `entries` (./core/records.ts,
        // `clampToDeliveryCap`). Each collection gets its own harness: the record engine minted
        // ids from ONE sequence per session, so a shared store would shift every id pin below.
        const writer = quiet(brain(scripted([])));

        // `content` is `getOnly` and never rides a list (./core/chapter.ts:58), so the
        // 3,900-character SUMMARY is what floods a chapters page.
        for (let index = 0; index < 30; index += 1) {
            await writer.executeTool('chapters', { action: 'add', title: `c${index}`, summary: `c${index}`.padEnd(3_900, 'z') });
        }

        const chapters = (await writer.executeTool('chapters', { action: 'list', limit: 100 })) as Record<string, any>;

        expect(deliveredBytes(chapters)).toBe(32_688);
        expect(deliveredBytes(chapters) <= MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(true);
        expect(chapters.chapters.map((row: Record<string, unknown>) => row.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
        expect(chapters.counts).toEqual({ total: 30, planned: 30, draft: 0, complete: 0 });
        expect(chapters.budgetTruncated).toBe(true);
        expect(chapters.deliveryBudgetBytes).toBe(32_768);
        // `nextAfterId` is the R2/T2.1 cursor for a sortable collection, and it is RECOMPUTED
        // against the rows that survived: the collection's own 64 KiB budget loaded more rows
        // than the cap holds, so its cursor named a row this clamp withheld — and a caller that
        // switched page orders by following it would have skipped everything in between.
        expect(chapters.page).toEqual({
            offset: 0,
            limit: 100,
            hasMore: true,
            nextOffset: 8,
            nextAfterId: '8',
            budgetTruncated: true,
            deliveryBudgetBytes: 32_768
        });
        // No delivered row lost a FIELD here — only rows were withheld — so the key that names
        // a field omission stays absent, on the wrapper path as on the engine surface.
        expect('fieldsWithheld' in chapters).toBe(false);

        const profileHost = quiet(brain(scripted([])));

        for (let index = 0; index < 12; index += 1) {
            await profileHost.executeTool('profiles', { action: 'add', name: `p${index}`, description: `p${index}`.padEnd(3_900, 'v') });
        }

        const profiles = (await profileHost.executeTool('profiles', { action: 'list', limit: 100 })) as Record<string, any>;

        expect(deliveredBytes(profiles)).toBe(32_696);
        expect(profiles.profiles.map((row: Record<string, unknown>) => row.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
        expect(profiles.counts).toEqual({ total: 12 });
        expect(profiles.page).toEqual({
            offset: 0,
            limit: 100,
            hasMore: true,
            nextOffset: 8,
            budgetTruncated: true,
            deliveryBudgetBytes: 32_768
        });
    });
});
