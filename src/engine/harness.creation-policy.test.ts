// Tool creation policy, budget, and run-depth authority (R12).
//
// Contract pinned here:
//   - `toolCreation` defaults to 'all' (every agent sees toolCreate);
//   - a RANK LETTER (e.g. 'A') declares the tool only to that rank and every rank
//     toward A, and rejects a guessed call from an agent below the gate;
//   - `false` registers no model-facing tool at all, while the HOST path
//     `harness.createTool()` keeps working;
//   - the creation budget is a LIFETIME budget: reset() does not restore it;
//   - the budget is PER INSTANCE (issue 0003B): N harnesses built from one
//     configuration hold N budgets, and a configured catalogue tool never spends one;
//   - `maxCreatedTools` is validated at construction;
//   - runs nest at most one level deep, enforced centrally, so a tool holding the
//     whole `context` (including a model-CREATED tool) cannot widen the
//     hierarchy — while a Rank A agent's own ctx.run still works.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type { Agent, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from './index';

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

const content = (message: unknown): string => (message as { content: string }).content;

const creation = {
    name: 'repeat',
    description: 'Repeat text.',
    tags: ['text', 'repeat'],
    source: 'return args;'
};

describe('toolCreation policy', () => {
    it('defaults to all: a lower-ranked agent sees toolCreate too', async () => {
        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted([callTool('c1', 'delegate', '{"agent":"researcher","input":"go"}'), answer('final')])
        );
        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        await writer('go');

        expect(writer.tools.toolCreate).toBeDefined();
        // R9-R11: 'all' still REGISTERS the row for every agent, but it is
        // searchable now, so a lower-ranked agent reaches it through toolRequest instead of
        // seeing it declared on the first request.
        expect(writer.tools.toolCreate.visibility).toBe('searchable');
        expect(declaredNames(seenResearcher[0])).toEqual(['toolRequest', 'tasks']);
    });

    it('a rank gate hides the tool from agents below it and rejects a guessed call', async () => {
        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(
            scripted([callTool('r1', 'toolCreate', JSON.stringify(creation)), answer('blocked')], seenResearcher)
        );
        const writerAgent = brain(
            scripted([callTool('c1', 'delegate', '{"agent":"researcher","input":"go"}'), answer('final')])
        );
        const writer = harness({
            agents: { writer: writerAgent, researcher },
            presets: false,
            // Rank A is the faithful replacement for the removed `'primary'` policy:
            // the entry agent (Rank A in an unranked roster) keeps the capability, the
            // Rank B researcher does not.
            toolCreation: 'A'
        });

        await writer('go');

        // R9-R11: toolCreate is not declared to anybody, and the rank gate additionally
        // keeps it out of the LOWER-RANKED agent's declaration list — so even once the
        // name is enabled harness-wide, the Rank B researcher never sees it.
        expect(declaredNames(seenResearcher[0])).toEqual([
            'toolRequest',
            'tasks',
        ]);

        // A guessed call is answered, not executed. GATE ORDER is what this pins: the
        // searchable name is registered but not enabled for this run, so the enablement
        // door answers first. The rank refusal is the NEXT door, and the test below pins
        // it by enabling the name and calling again.
        expect(content(researcher.messages[2])).toBe(
            'Tool "toolCreate" is registered but not enabled yet. Call toolRequest with tags like "tools", "create", "extension" to enable it.'
        );
        expect(writer.tools.repeat).toBeUndefined();

        // The Rank A entry agent still sees it.
        const seenWriter = brain(scripted([answer('x')]));
        expect(harness({ agents: { writer: seenWriter }, presets: false, toolCreation: 'A' }).tools.toolCreate)
            .toBeDefined();
    });

    it('a rank gate refuses an enabled toolCreate by rank, naming both ranks', async () => {
        const researcher = brain(
            scripted([callTool('r1', 'toolCreate', JSON.stringify(creation)), answer('blocked')])
        );
        const writerAgent = brain(
            scripted([callTool('c1', 'delegate', '{"agent":"researcher","input":"go"}'), answer('final')])
        );
        const writer = harness({
            agents: { writer: writerAgent, researcher },
            presets: false,
            toolCreation: 'A'
        });

        // Discovery on the HOST door enables the searchable `toolCreate` for the whole
        // harness (the same move the nesting fixture below uses for a created tool), so
        // the enablement door is open and the refusal below CAN only come from the rank
        // gate: `createToolForAgent` checks the caller's rank against the ceiling.
        await writer.executeTool('toolRequest', { names: ['toolCreate'] });

        await writer('go');

        // Exact message: it names the gate rank and the caller's own rank, so a model that
        // guessed the name learns which standing it lacks. The `Tool "toolCreate" failed:`
        // prefix is how a tool that RAN and threw reports, as opposed to the enablement
        // door above, which answers without executing anything.
        expect(content(researcher.messages[2])).toBe(
            'Tool "toolCreate" failed: Tool creation is limited to Rank A and above in this harness; "researcher" holds Rank B.'
        );
        // Nothing was created.
        expect(writer.tools.repeat).toBeUndefined();
    });

    it('false: registers no model-facing tool, but the host path still creates', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            toolCreation: false
        });

        expect(writer.tools.toolCreate).toBeUndefined();

        // An operator action is not a model privilege.
        const created = writer.createTool(creation);
        expect(created.name).toBe('repeat');
        expect(writer.tools.repeat).toBe(created);
    });

    it('rejects an unknown policy at construction', () => {
        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                toolCreation: 'sometimes' as never
            })
        ).toThrow('toolCreation must be "all", false, or a rank letter (A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z). Received sometimes.');
    });
});

describe('creation budget', () => {
    it('is a lifetime budget that reset() does not restore', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            maxCreatedTools: 2
        });

        writer.createTool({ ...creation, name: 'one' });
        writer.createTool({ ...creation, name: 'two' });

        // reset() clears conversation and discovery, NOT the registry or the budget.
        writer.reset();
        expect(writer.tools.one).toBeDefined();
        expect(writer.tools.two).toBeDefined();

        expect(() => writer.createTool({ ...creation, name: 'three' })).toThrow(
            'This harness already created 2 tools; reuse an existing tool instead of creating more.'
        );
    });

    it('is a per-instance budget: a spent ceiling does not bind the next harness', () => {
        // Issue 0003: the counter shares the registry's lifetime, so a second instance
        // starts at zero, and the refused call leaves the first instance untouched.
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            maxCreatedTools: 1
        });

        const firstCreated = writer.createTool({ ...creation, name: 'one' });
        expect(() => writer.createTool({ ...creation, name: 'two' })).toThrow(
            'This harness already created 1 tools; reuse an existing tool instead of creating more.'
        );

        // The refusal is a pure refusal: no half-created tool is registered, and the
        // spent count is still exactly the budget.
        expect(writer.tools.two).toBeUndefined();
        expect(writer.tools.one).toBe(firstCreated);
        expect(writer.snapshot().createdToolCount).toBe(1);
        expect(writer.snapshot().createdTools.map((entry) => entry.name)).toEqual(['one']);

        const sibling = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            maxCreatedTools: 1
        });

        // Nothing was published into the sibling, so nothing was spent: the same name on
        // the same source creates cleanly, and each instance keeps its own instance.
        const siblingCreated = sibling.createTool({ ...creation, name: 'one' });
        expect(siblingCreated.name).toBe('one');
        expect(sibling.tools.one).toBe(siblingCreated);
        expect(sibling.tools.one).not.toBe(writer.tools.one);
        expect(sibling.snapshot().createdToolCount).toBe(1);
        expect(sibling.snapshot().createdTools.map((entry) => entry.name)).toEqual(['one']);

        // The sibling's spend did not leak back into the first instance either: it still
        // refuses at its own limit, and the message still reports 1 rather than 2.
        expect(() => writer.createTool({ ...creation, name: 'three' })).toThrow(
            'This harness already created 1 tools; reuse an existing tool instead of creating more.'
        );
        expect(writer.tools.three).toBeUndefined();
        expect(writer.snapshot().createdToolCount).toBe(1);
    });

    it('validates maxCreatedTools at construction', () => {
        expect(() =>
            harness({ agents: { writer: brain(scripted([answer('hi')])) }, maxCreatedTools: 0 })
        ).toThrow('maxCreatedTools must be a positive safe integer; received 0.');
        expect(() =>
            harness({ agents: { writer: brain(scripted([answer('hi')])) }, maxCreatedTools: 1.5 })
        ).toThrow('maxCreatedTools must be a positive safe integer; received 1.5.');
    });
});

describe('run depth authority', () => {
    it('lets the entry agent run a tool that starts one agent through ctx.run', async () => {
        const summarizer = brain(scripted([answer('summary')]));
        const delegate = tool({
            description: 'Summarise through a sibling agent.',
            tags: ['agents'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('summarizer', 'text')).content
        });
        const entry = brain(scripted([callTool('c1', 'delegate', '{}'), answer('done')]));
        const writer = harness({
            agents: { writer: entry, summarizer },
            tools: { delegate },
            presets: false
        });

        await writer('go');

        // The trusted entry-agent ctx.run still works (depth 2, and the roster's
        // ceiling is 2 because it spans exactly two distinct ranks).
        expect(content(entry.messages[2])).toBe('summary');
        expect(withoutIds(summarizer.messages)).toEqual([
            { role: 'user', content: 'text' },
            { role: 'assistant', content: 'summary' }
        ]);
    });

    it('refuses a third level from inside a delegated agent, even from a created tool', async () => {
        const editor = brain(scripted([answer('edited')]));
        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(
            scripted([callTool('r1', 'nest', '{}'), answer('blocked')], seenResearcher)
        );

        // A model-CREATED tool gets the whole context, so it can call run(). It must
        // not be able to widen "one level of delegation".
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"go"}'
                ),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher, editor },
            presets: false
        });

        // Register the nesting tool through the SAME host path toolCreate uses, as
        // a created (searchable, immediately enabled) tool.
        writer.createTool({
            name: 'nest',
            description: 'Start another agent.',
            tags: ['agents'],
            source: "return context.run('editor', 'edit');"
        });
        // The Rank B researcher never discovered it: make it callable for this
        // fixture by
        // running discovery through the same harness (its result enables it).
        await writer.executeTool('toolRequest', { tags: ['agents'] });

        await writer('go');

        expect(content(researcher.messages[2])).toBe(
            // The ceiling is the DISTINCT-RANK COUNT (writer is Rank A, researcher and
            // editor are both Rank B), so a third level is impossible: `ctx.run` never
            // consults rank, so this is the nesting bound doing the work.
            'Tool "nest" failed: Agent "editor" cannot run: this harness configures 2 distinct ranks, so runs nest at most 2 levels deep, and "researcher" is already running at that depth.'
        );
        // The editor never ran, so it has no transcript.
        expect(editor.messages).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Issue 0003B — the SCOPE of the creation budget.
//
// The counter belongs to ONE harness instance (src/types/index.ts, `maxCreatedTools`
// states it; the rejected alternatives — a thread-local or process-global registry,
// or a host-side counter — cannot survive per-instance snapshot/restore). Two things
// follow and are pinned here:
//   - a host that builds N instances from ONE configuration object gets N
//     independent budgets, and nothing created in one instance is visible in another;
//   - a configured/catalogue tool (`tools: { name: { tool, source } }`, issue 0003) is
//     catalogue state, never a creation, so it never spends the budget — which is the
//     shape a host uses to share reviewed tools across conversations.
// The budget MESSAGE quotes the limit (`maxCreatedTools`), not the number created, so
// the expected strings below are written with the limit spelled out.
// ---------------------------------------------------------------------------
describe('creation budget scope (issue 0003B)', () => {
    it('is one budget per instance, not one per process', () => {
        // ONE configuration object, TWO harnesses built from it.
        const configuration = {
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            maxCreatedTools: 2
        };

        const first = harness(configuration);
        first.createTool({ ...creation, name: 'firstOne' });
        first.createTool({ ...creation, name: 'firstTwo' });
        expect(() => first.createTool({ ...creation, name: 'firstThree' })).toThrow(
            'This harness already created 2 tools; reuse an existing tool instead of creating more.'
        );

        // A SECOND instance is unaffected by the first one's spending: the budget is
        // instance state, and so is the registry it guards.
        const second = harness(configuration);
        expect(second.tools.firstOne).toBeUndefined();
        expect(second.tools.firstTwo).toBeUndefined();

        second.createTool({ ...creation, name: 'secondOne' });
        expect(second.tools.secondOne).toBeDefined();
        second.createTool({ ...creation, name: 'secondTwo' });
        expect(() => second.createTool({ ...creation, name: 'secondThree' })).toThrow(
            'This harness already created 2 tools; reuse an existing tool instead of creating more.'
        );

        // Neither instance can see the other's created tool, which is what makes the
        // per-instance budget the right guard rather than a global one.
        expect(first.tools.secondOne).toBeUndefined();
        expect(second.tools.firstOne).toBeUndefined();
    });

    it('is never spent by a configured catalogue tool', () => {
        // The issue-0003 catalogue shape: a prebuilt definition beside its bytes.
        const shared = {
            catalogueProbe: {
                tool: tool({
                    name: 'catalogueProbe',
                    description: 'Report a value.',
                    tags: ['test', 'catalogue'],
                    execute: () => 'catalogue'
                }),
                source: {
                    moduleText: `
export const metadata = {
    name: 'catalogueProbe',
    description: 'Report a value.',
    tags: ['test', 'catalogue'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const execute = () => 'catalogue';
`
                }
            }
        };

        // Budget of ONE, and the catalogue tool arrives without touching it.
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            maxCreatedTools: 1,
            tools: shared
        });

        expect(writer.tools.catalogueProbe?.name).toBe('catalogueProbe');
        // A configured entry is registered, so its name is not a creation and the
        // instance still has its full budget of one.
        expect(writer.toolSource('catalogueProbe')?.name).toBe('catalogueProbe');

        writer.createTool({ ...creation, name: 'onlyCreation' });
        expect(() => writer.createTool({ ...creation, name: 'secondCreation' })).toThrow(
            'This harness already created 1 tools; reuse an existing tool instead of creating more.'
        );

        // The catalogue tool is still installed after the budget is exhausted: a
        // refusal about creations never touches catalogue state.
        expect(writer.tools.catalogueProbe?.name).toBe('catalogueProbe');
    });
});
