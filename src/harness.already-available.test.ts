// toolRequest + already-available core tools (R1, reshaped by R9-R11).
//
// Contract pinned here:
//   - an exact capability tag ("delegate") reports the tool in `alreadyAvailable`
//     when the CALLER already has it DECLARED, instead of claiming no match;
//   - that report never enables anything, never appears in `enabled`/`tools`,
//     never spends the maxEnabledTools bound, and never enters `discoveredTools`;
//   - R9-R11 demotes eleven runtime rows (toolRegistry, toolList, toolManage,
//     toolCreate, profileManage, chapterManage, locationManage, agentManage,
//     agentResult, actionRequest, threadFork) to `searchable`. They are no longer
//     already-available: a matching query ENABLES them like any other discovery,
//     and only toolRequest/task/delegate can still land in `alreadyAvailable`;
//   - when a query matches nothing, the honest answer pairs `unmatchedTags` (for a
//     tag no registered tool carries) or `availableTags` (the searchable
//     vocabulary) with an empty `enabled`;
//   - a one-agent harness (no delegate at all) and a SUBAGENT (delegate is
//     primary-only) get no already-available entry - their absence stays honest.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';
import {
    AGENT_MANAGE_METADATA,
    AGENT_RESULT_METADATA,
    TOOL_CREATE_METADATA,
    TOOL_REQUEST_METADATA,
    agentDelegateMetadata
} from './core/metadata';

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

const brain = (stream: HarnessStream) => agent({ model: 'merge/ds4-flash', stream });

const content = (message: unknown): string => (message as { content: string }).content;

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

// The exact runtime metadata delegate carries in a harness whose only
// subagent is "researcher" (core/metadata.ts agentDelegateMetadata). Derived from
// the projection itself so a wording change is a one-place edit, not a second copy
// that silently drifts (T28).
const DELEGATE_MATCH = (() => {
    const projected = agentDelegateMetadata(['researcher']);
    return { name: projected.name, description: projected.description, tags: [...projected.tags] };
})();

// Discovery cards are metadata only: name, description, tags. The literals come
// from the one declarative source the runtime registers, so an expectation here
// cannot drift from what the model actually sees.
const match = (metadata: { name: string; description: string; tags: readonly string[] }) => ({
    name: metadata.name,
    description: metadata.description,
    tags: [...metadata.tags]
});

const AGENT_MATCHES = [match(AGENT_MANAGE_METADATA), match(AGENT_RESULT_METADATA)];
const TOOL_CREATE_MATCH = match(TOOL_CREATE_METADATA);

// What an "agents" capability query enables now: the two demoted agent rows (their
// tags/description carry the agent vocabulary) plus toolCreate, whose description
// names `agent` and `agents` in the execution context.
const AGENT_QUERY_ENABLED = ['agentManage', 'agentResult', 'toolCreate'];
const AGENT_QUERY_TOOLS = [...AGENT_MATCHES, TOOL_CREATE_MATCH];

// R9-R11: the searchable vocabulary a no-match query reports for this harness.
// It is the sorted union of the eleven demoted rows' tags - toolRegistry, toolList,
// toolManage, toolCreate, profileManage, chapterManage, locationManage, agentManage,
// agentResult, actionRequest, and threadFork. delegate/toolRequest/task are declared
// core, so their tags are not part of the discoverable vocabulary.
const SEARCHABLE_TAGS = [
    'agents',
    'answer',
    'book',
    'branch',
    'catalogue',
    'chapter',
    'chapters',
    'character',
    'characters',
    'compile',
    'create',
    'dynamic',
    'edit',
    'extension',
    'fork',
    'history',
    'inspect',
    'inventory',
    'list',
    'location',
    'locations',
    'manage',
    'outline',
    'output',
    'people',
    'person',
    'place',
    'places',
    'preview',
    'profile',
    'profiles',
    'registry',
    'reload',
    'research',
    'result',
    'results',
    'self-modifying',
    'setting',
    'source',
    'story',
    'subagent',
    'summarize',
    'team',
    'thread',
    'tools',
    'world',
    'writing'
];

describe('toolRequest already-available core tools', () => {
    it('reports delegate on an exact wire-name query instead of no match', async () => {
        const entry = brain(
            scripted([callTool('c1', 'toolRequest', '{"tags":["delegate"]}'), answer('done')])
        );
        const writer = harness({
            agents: { writer: entry, researcher: brain(scripted([answer('found')])) },
            presets: false
        });

        await writer('delegate?');

        // The primary HAS delegate declared, so the answer names it. Nothing is
        // enabled, nothing is left over, and the tag is not called unmatched. The
        // demoted rows now offer their vocabulary instead of an empty list.
        expect(JSON.parse(content(entry.messages[2]))).toEqual({
            enabled: [],
            tools: [],
            matched: 0,
            omitted: 0,
            alreadyAvailable: [DELEGATE_MATCH],
            availableTags: SEARCHABLE_TAGS
        });
        expect(writer.discoveredTools).toEqual([]);
    });

    it('enables the demoted agent rows and reports only delegate as already available', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["agents","delegate","delegation"]}'),
                answer('done')
            ])
        );
        const writer = harness({
            agents: { writer: entry, researcher: brain(scripted([answer('found')])) },
            presets: false
        });

        await writer('delegate?');

        // delegate stays declared core, so it is reported and NOT re-enabled.
        // agentManage/agentResult/toolCreate are searchable rows now: the query
        // enables them, spends the match count, and lists their cards.
        expect(JSON.parse(content(entry.messages[2]))).toEqual({
            enabled: AGENT_QUERY_ENABLED,
            tools: AGENT_QUERY_TOOLS,
            matched: 3,
            omitted: 0,
            alreadyAvailable: [DELEGATE_MATCH]
        });

        // Enabling a searchable row is a discovery: it lands in the session record.
        expect(writer.discoveredTools).toEqual(AGENT_QUERY_ENABLED);
    });

    it('does not advertise delegate to a one-agent harness that lacks it', async () => {
        const entry = brain(
            scripted([
                callTool(
                    'c1',
                    'toolRequest',
                    '{"tags":["delegate","agents","delegate"]}'
                ),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, presets: false });

        await writer('delegate?');

        // No subagents means no delegate was ever registered, so the honest answer
        // has no alreadyAvailable key at all and reports the tag as unmatched. Tags
        // come back normalized (trimmed + lower-cased).
        expect(writer.tools.delegate).toBeUndefined();
        expect(JSON.parse(content(entry.messages[2]))).toEqual({
            enabled: AGENT_QUERY_ENABLED,
            tools: AGENT_QUERY_TOOLS,
            matched: 3,
            omitted: 0,
            unmatchedTags: ['delegate']
        });
    });

    it('does not advertise delegate to a subagent that never receives it', async () => {
        // The primary delegates once; INSIDE that run the subagent queries the exact
        // name and the synonyms. delegate is core but primary-only, so the
        // subagent's own toolRequest must not list it.
        const researcher = brain(
            scripted([
                callTool('r1', 'toolRequest', '{"tags":["delegate","agents","delegate"]}'),
                answer('found')
            ])
        );
        const entry = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry, researcher }, presets: false });

        await writer('delegate?');

        // Subagent history: [0] user, [1] assistant tool call, [2] tool result.
        expect(JSON.parse(content(researcher.messages[2]))).toEqual({
            enabled: AGENT_QUERY_ENABLED,
            tools: AGENT_QUERY_TOOLS,
            matched: 3,
            omitted: 0,
            unmatchedTags: ['delegate']
        });
    });

    it('reports core matches without spending the enabled bound or changing declarations', async () => {
        const seen: HarnessStreamRequest[] = [];
        const fixtures = Array.from({ length: 7 }, (_, index) => {
            const name = `tool-${String(index).padStart(2, '0')}`;
            return tool({ name, description: `${name} fixture.`, tags: ['tools'], execute: () => name });
        });

        const entry = brain(
            scripted([callTool('c1', 'toolRequest', '{"tags":["tools"]}'), answer('done')], seen)
        );
        const writer = harness({
            agents: { writer: entry },
            tools: Object.fromEntries(fixtures.map((definition) => [definition.name, definition])),
            presets: false
        });

        await writer('list tools');

        const result = JSON.parse(content(entry.messages[2]));
        const fixtureNames = fixtures.map((definition) => definition.name);

        // R9-R11: the "tools" tag now reaches four demoted rows as well, so twelve
        // matches are enabled - selection is uncapped and the default enabled bound
        // (32) is far above this set. Only the still-declared toolRequest row is
        // REPORTED rather than enabled, and it never enters the discovered record.
        const demotedMatches = ['toolCreate', 'toolList', 'toolManage', 'toolRegistry', 'threadFork'];
        const enabledNames = [...fixtureNames, ...demotedMatches];
        expect(result.enabled).toEqual(enabledNames);
        expect(result.tools.map((matchEntry: { name: string }) => matchEntry.name)).toEqual(enabledNames);
        expect(result.matched).toBe(12);
        expect(result.omitted).toBe(0);
        expect(result.alreadyAvailable.map((matchEntry: { name: string }) => matchEntry.name)).toEqual([
            TOOL_REQUEST_METADATA.name
        ]);

        // Core exposure semantics are untouched: the twelve searchable tools joined
        // the discovery set, and the next request declares the core pair, the
        // configured fixtures, then the enabled rows in discovery order.
        expect(writer.discoveredTools).toEqual(enabledNames);
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'task', ...enabledNames]);
    });
});

// ---------------------------------------------------------------------------
// T28 — a pending-only control is discoverable exactly while it is actionable
// ---------------------------------------------------------------------------
//
// `toolCancel` is declared only while the calling agent has work in flight, and it
// used to be invisible to discovery in exactly that window: a model that searched for
// "cancel"/"abort"/"kill" got `matched: 0` and concluded the capability did not exist,
// even though the tool was declared on that very request. The fix reports it through
// `alreadyAvailable` — a report, not a grant, so nothing is enabled and no cap slot is
// spent — and excludes the `toolRequest` call that is asking, so an idle agent still
// gets an honest "nothing to cancel".
describe('toolCancel discovery (T28)', () => {
    it('reports toolCancel while a call is pending, and not while the query itself is the only work', async () => {
        let release!: () => void;
        const hang = new Promise<void>((resolve) => {
            release = resolve;
        });

        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    // Turn 0: start a long call.
                    callTool('h1', 'hang', '{}'),
                    // Turn 1: search for the cancellation capability WHILE it is pending.
                    callTool('q1', 'toolRequest', '{"tags":["cancel"]}'),
                    // Turn 2+: state-based. Only once the hang's REAL result is visible
                    // is the board empty, so the second query is the idle case.
                    answer('done')
                ],
                seen
            )
        );

        // The stream is state-based rather than turn-indexed: the run takes a turn per
        // completion, so a fixed index would race the async call it is waiting on.
        let turn = 0;
        const stateful: HarnessStream = async function* stream(request) {
            seen.push(request);
            turn++;

            if (turn === 1) {
                yield* [
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'h1', name: 'hang', arguments: '{}' }]
                    } as HarnessStreamEvent
                ];
                return;
            }

            const hangSettled = request.messages.some(
                (message) =>
                    message.role === 'tool' &&
                    message.toolCallId === 'h1' &&
                    // The projection inserts a PLACEHOLDER for a still-pending call, so
                    // "a tool message exists" is not "the call settled". The real result
                    // is the one that is not the pending envelope.
                    !message.content.startsWith('{"status":"pending"')
            );
            const queried = request.messages.some(
                (message) => message.role === 'tool' && message.toolCallId === 'q1'
            );

            if (!queried) {
                yield* [
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'q1', name: 'toolRequest', arguments: '{"tags":["cancel"]}' }]
                    } as HarnessStreamEvent
                ];
                return;
            }

            if (!hangSettled) {
                // Pause: the pending call is still running, so wait for it.
                yield* [{ type: 'text', delta: 'waiting' } as HarnessStreamEvent];
                yield* [{ type: 'done', stopReason: 'stop', toolCalls: [] } as HarnessStreamEvent];
                return;
            }

            if (!request.messages.some((message) => message.role === 'tool' && message.toolCallId === 'q2')) {
                yield* [
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'q2', name: 'toolRequest', arguments: '{"tags":["cancel"]}' }]
                    } as HarnessStreamEvent
                ];
                return;
            }

            yield* [{ type: 'text', delta: 'done' } as HarnessStreamEvent];
            yield* [{ type: 'done', stopReason: 'stop', toolCalls: [] } as HarnessStreamEvent];
        };

        const writer = harness({
            agents: { writer: agent({ model: 'merge/ds4-flash', stream: stateful }) },
            tools: {
                hang: tool({
                    description: 'Hang until released.',
                    tags: ['test'],
                    visibility: 'core',
                    // ASYNC: a sync call would hold the batch gate, so the run could not
                    // take the discovery turn while the call is still pending — which is
                    // the exact window this test is about.
                    mode: 'async',
                    execute: () => hang.then(() => 'released')
                })
            },
            presets: false
        });

        const running = writer('go');
        await new Promise((resolve) => setTimeout(resolve, 20));

        const toolResultOf = (callId: string): string => {
            const message = writer.agent.messages.find(
                (candidate) => candidate.role === 'tool' && candidate.toolCallId === callId
            );
            if (message === undefined) throw new Error(`no tool result for ${callId}`);
            return content(message);
        };

        // The query ran while `hang` was pending, so the answer must name toolCancel.
        const pendingAnswer = JSON.parse(toolResultOf('q1'));
        expect(pendingAnswer.alreadyAvailable.map((match: { name: string }) => match.name)).toEqual([
            'toolCancel'
        ]);
        // A report only: toolCancel was never ENABLED and no cap slot was spent on it.
        expect(pendingAnswer.enabled).not.toContain('toolCancel');
        expect(writer.discoveredTools).not.toContain('toolCancel');

        release();
        await running;

        // With nothing pending, the same query is an honest miss for the CONTROL: the
        // toolRequest call that is asking must not count as work to cancel. (Other
        // searchable rows may still match the tag; only toolCancel is the subject here.)
        const idleAnswer = JSON.parse(toolResultOf('q2'));
        const idleNames = (idleAnswer.alreadyAvailable ?? []).map(
            (match: { name: string }) => match.name
        );
        expect(idleNames).not.toContain('toolCancel');
        expect(idleAnswer.enabled).not.toContain('toolCancel');
    });
});
