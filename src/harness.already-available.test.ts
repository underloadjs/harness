// toolRequest + already-available core tools (R1).
//
// Contract pinned here:
//   - an exact wire name ("agentDelegate") and its capability tags
//     ("agents"/"delegate"/"delegation") report the tool in `alreadyAvailable`
//     when the CALLER already has it declared, instead of claiming no match;
//   - that report never enables anything, never appears in `enabled`/`tools`,
//     never spends the five-match cap, and never enters `discoveredTools`;
//   - a one-agent harness (no agentDelegate at all) and a SUBAGENT (agentDelegate
//     is primary-only) get no such entry - their absence stays honest, and every
//     query tag is reported as unmatched;
//   - the core declarations are unchanged: already-available tools were declared
//     before the call and stay declared after it.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';
import { AGENT_MANAGE_METADATA, AGENT_RESULT_METADATA } from './core/metadata';

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

// The exact runtime metadata agentDelegate carries in a harness whose only
// subagent is "researcher" (core/metadata.ts agentDelegateMetadata).
const DELEGATE_MATCH = {
    name: 'agentDelegate',
    description:
        'Delegate a self-contained task to a configured subagent and return its answer. Subagents: researcher. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.',
    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team']
};

// R3: agentManage/agentResult are core too, and their `agents` tag makes them
// genuine matches for an agent-capability query. The literal metadata is imported
// from the one declarative source the runtime registers, so this expectation
// cannot drift from what the model actually sees.
const agentMatch = (metadata: { name: string; description: string; tags: readonly string[] }) => ({
    name: metadata.name,
    description: metadata.description,
    tags: [...metadata.tags]
});

const AGENT_MATCHES = [agentMatch(AGENT_MANAGE_METADATA), agentMatch(AGENT_RESULT_METADATA)];

describe('toolRequest already-available core tools', () => {
    it('reports agentDelegate on an exact wire-name query instead of no match', async () => {
        const entry = brain(
            scripted([callTool('c1', 'toolRequest', '{"tags":["agentDelegate"]}'), answer('done')])
        );
        const writer = harness({
            agents: { writer: entry, researcher: brain(scripted([answer('found')])) },
            presets: false
        });

        await writer('delegate?');

        // The primary HAS agentDelegate declared, so the answer names it. Nothing is
        // enabled, nothing is left over, and the tag is not called unmatched.
        expect(JSON.parse(content(entry.messages[2]))).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            alreadyAvailable: [DELEGATE_MATCH],
            availableTags: []
        });
        expect(writer.discoveredTools).toEqual([]);
    });

    it('reports agentDelegate for the capability tags agents/delegate/delegation', async () => {
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

        // All three synonyms are exact tags on agentDelegate (the metadata carries
        // "delegation" as the noun form), so `unmatchedTags` is absent from the
        // exact shape. The two agent-inspection core tools also carry the exact
        // "agents" tag, so they are reported (metadata only) beside it.
        expect(JSON.parse(content(entry.messages[2]))).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            alreadyAvailable: [DELEGATE_MATCH, ...AGENT_MATCHES],
            availableTags: []
        });
    });

    it('does not advertise agentDelegate to a one-agent harness that lacks it', async () => {
        const entry = brain(
            scripted([
                callTool(
                    'c1',
                    'toolRequest',
                    '{"tags":["agentDelegate","agents","delegate"]}'
                ),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, presets: false });

        await writer('delegate?');

        // No subagents means no agentDelegate was ever registered, so the honest
        // answer is "nothing available" plus every tag reported as unmatched. Tags
        // come back normalized (trimmed + lower-cased).
        expect(writer.tools.agentDelegate).toBeUndefined();
        expect(JSON.parse(content(entry.messages[2]))).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            unmatchedTags: ['agentdelegate', 'delegate'],
            alreadyAvailable: AGENT_MATCHES,
            availableTags: []
        });
    });

    it('does not advertise agentDelegate to a subagent that never receives it', async () => {
        // The primary delegates once; INSIDE that run the subagent queries the exact
        // name and the synonyms. agentDelegate is core but primary-only, so the
        // subagent's own toolRequest must not list it.
        const researcher = brain(
            scripted([
                callTool('r1', 'toolRequest', '{"tags":["agentDelegate","agents","delegate"]}'),
                answer('found')
            ])
        );
        const entry = brain(
            scripted([
                callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find facts"}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry, researcher }, presets: false });

        await writer('delegate?');

        // Subagent history: [0] user, [1] assistant tool call, [2] tool result.
        expect(JSON.parse(content(researcher.messages[2]))).toEqual({
            enabled: [],
            tools: [],
            remaining: 0,
            unmatchedTags: ['agentdelegate', 'delegate'],
            alreadyAvailable: AGENT_MATCHES,
            availableTags: []
        });
    });

    it('reports core matches without spending the cap or changing the declarations', async () => {
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

        // Seven searchable matches, the usual five-slot cap, two counted as
        // remaining. toolCreate and toolRequest are core and match "tools", but they
        // are REPORTED, not enabled: the shortlist holds only the fixtures.
        expect(result.enabled).toEqual(['tool-00', 'tool-01', 'tool-02', 'tool-03', 'tool-04']);
        expect(result.tools.map((match: { name: string }) => match.name)).toEqual([
            'tool-00',
            'tool-01',
            'tool-02',
            'tool-03',
            'tool-04'
        ]);
        expect(result.remaining).toBe(2);
        expect(result.truncated).toBe(true);
        expect(result.alreadyAvailable.map((match: { name: string }) => match.name)).toEqual([
            'toolCreate',
            'toolRegistry',
            'toolRequest'
        ]);

        // Core exposure semantics are untouched: only the five searchable tools
        // joined the discovery set, and the next request declares the core set plus
        // exactly those five (already-available tools were always declared).
        expect(writer.discoveredTools).toEqual([
            'tool-00',
            'tool-01',
            'tool-02',
            'tool-03',
            'tool-04'
        ]);
        expect(declaredNames(seen[1])).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'tool-00',
            'tool-01',
            'tool-02',
            'tool-03',
            'tool-04'
        ]);
    });
});
