// F8 (2026-11-25) — THE TWO DIAGNOSTICS A CALLER WAS LEFT TO GUESS.
//
// Both cases come from the delegate field report's "worth acting on" section, and both are
// diagnostics only: neither changes a contract, a default, or a grant. This file is deliberately
// SEPARATE from `harness.delegation.test.ts` (whose envelope and turn-cap pins belong to that
// file's own contract) so the additive behaviour it pins has an owner of its own.
//
// 1. AN UNRECOGNISED `scope.tools` NAME IS NOW VISIBLE TO THE CALLER.
//    The mechanism it probes is unchanged and stays unchanged: `isToolInScope` (./harness.ts) is
//    name-equality against RESOLVED definitions, so an entry no tool answers to matches nothing
//    — the declaration filter never shows it, the launch gate has nothing to refuse, and the
//    child gets its documented `forbidden` answer when it asks. A misspelled name was therefore
//    never a contract violation; the defect was that the CALLER was told nothing, so "the child
//    could not use `red`" read like a missing capability rather than a typo. The remedy is one
//    additive, CONDITIONAL envelope entry (`HarnessDelegationResult.notes`): present exactly when
//    something resolves to nothing, absent otherwise — which is why every envelope pin written
//    before this field exists still passes untouched.
//
// 2. A `maxTurns` FAILURE NOW NAMES THE N ⇒ N-1 ARITHMETIC. `maxTurns` counts MODEL REQUESTS and
//    the answer must be one of them (`run.iteration >= turnLimit`, checked BEFORE the increment),
//    so the N a caller writes is N-1 tool rounds and `maxTurns: 1` leaves a child ZERO — the
//    report's failing child burned 3,278 ms discovering that by hand. The guard, the bound, the
//    `turn-cap` stop reason and the unset default are all untouched, and the harness-wide
//    `maxIterations` sentence stays byte-for-byte what it was (pinned below, because "the session
//    owns this cap" and "I set this cap" must stay distinguishable from the text alone).
//
// Every expected value here is written out in full: the note sentences and the cap messages are
// exact strings, and the child's declaration list is asserted WHOLE so a grant that silently
// widened or narrowed next to a typo would fail rather than slide past a `toMatchObject`.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from './index';
import type { Agent, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from './index';

// ---------------------------------------------------------------------------
// Fixtures, the same shape `harness.delegation.test.ts` uses: a scripted transport, a Rank A
// `writer` (the entry agent by roster order) and a Rank B `researcher` it may delegate to.
// ---------------------------------------------------------------------------

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        // One turn per REQUEST; past the end the last turn repeats, which is how a child that
        // keeps being asked (the turn-cap cases) keeps calling its tool.
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

const brain = (stream: HarnessStream): Agent => agent({ model: 'merge/ds4-flash', stream });

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

// The envelope the PARENT was handed for its `delegate` call, parsed out of the tool result the
// transcript holds. Keyed by call id rather than by message index, so a test that adds a turn
// does not silently start reading somebody else's result.
const envelopeOfCall = (messages: readonly unknown[], callId: string): Record<string, any> => {
    const message = messages.find(
        (entry) =>
            (entry as { role?: string; toolCallId?: string }).role === 'tool' &&
            (entry as { toolCallId?: string }).toolCallId === callId
    );

    if (message === undefined) throw new Error(`no tool result for ${callId}`);

    return JSON.parse((message as { content: string }).content) as Record<string, any>;
};

// One pair of brains, one harness: a delegated child, plus the two core capabilities the
// allowlist probes (`read` is always a real name here, `write` is the capability the child was
// NOT granted). `peek` is the always-available tool the turn-cap children call.
const pair = (options: {
    child: HarnessStream;
    parent: HarnessStream;
    maxIterations?: number;
}) => {
    const researcher = brain(options.child);
    const writerAgent = brain(options.parent);

    const writer = harness({
        agents: { writer: writerAgent, researcher },
        tools: {
            read: tool({
                description: 'Read.',
                tags: ['files'],
                visibility: 'core',
                execute: () => 'contents'
            }),
            write: tool({
                description: 'Write.',
                tags: ['files'],
                visibility: 'core',
                execute: () => 'written'
            }),
            peek: tool({
                description: 'Peek.',
                tags: ['test'],
                visibility: 'core',
                execute: () => 'a fact'
            })
        },
        presets: false,
        ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations })
    });

    return { writer, writerAgent, researcher };
};

// A child that never answers: every model request emits text plus one `peek` round, so the only
// thing that can end it is a count bound. `seen` counts the CHILD's model requests, which is the
// number the cap governs.
const neverAnswers = (seen: HarnessStreamRequest[]): HarnessStream => {
    return async function* stream(request) {
        seen.push(request);
        const turn = seen.length;

        yield { type: 'text', delta: `pass ${turn}` };
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: `p${turn}`, name: 'peek', arguments: '{}' }]
        };
    };
};

// ONE parent turn: the `delegate` call with a MODEL's arguments (so the real schema validates
// them). Each scripted turn is a FRAME ARRAY, so this returns `callTool`'s array directly — and
// the parent's own final answer is always the NEXT scripted turn, `answer('final')`.
const delegateCall = (args: string): HarnessStreamEvent[] => callTool('c1', 'delegate', args);

describe('delegate reports the scope.tools names that resolve to nothing (F8)', () => {
    it('names the misspelled name, grants it nothing, and still answers normally', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: scripted([answer('scoped answer')], childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"review src/a.ts","scope":{"tools":["read","red"]}}'), answer('final')])
        });

        await writer('go');

        // GRANT SEMANTICS UNCHANGED: the allowlist is still the whole bound (`read` in, `write`
        // out) and the typo adds nothing — the child sees exactly the names that resolve, plus
        // `toolRequest`, the door a scope can never close.
        expect(declaredNames(childSeen[0])).toEqual(['toolRequest', 'read']);

        const envelope = envelopeOfCall(writerAgent.messages, 'c1');

        // THE DIAGNOSTIC, verbatim: it names the entry, says what it is not, says what the child
        // DID get, and points at the one catalogue the child's own caller can query.
        expect(envelope.notes).toEqual([
            'scope.tools named "red": this harness has no tool by that name, so nothing is granted for it. The child\'s scope is the names that do resolve: "read". Check the spelling against the toolRequest catalogue.'
        ]);

        // A typo never fails the delegation: this is still an answered child with the ordinary
        // paging fields and no error.
        expect(envelope.agent).toBe('researcher');
        expect(envelope.content).toBe('scoped answer');
        expect(envelope.contentLength).toBe(13);
        expect(envelope.offset).toBe(0);
        expect(envelope.limit).toBe(8000);
        expect(envelope.truncated).toBe(false);
        expect(envelope.status).toBe('completed');
        expect(envelope).not.toHaveProperty('error');
    });

    it('omits the notes key entirely when every name resolves — the pre-F8 envelope is byte-for-byte intact', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: scripted([answer('clean')], childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"review src/a.ts","scope":{"tools":["read"]}}'), answer('final')])
        });

        await writer('go');

        expect(declaredNames(childSeen[0])).toEqual(['toolRequest', 'read']);

        // The WHOLE key list, in order: this is the pin that proves the field is additive and
        // conditional — a caller that enumerated the envelope before F8 enumerates the same keys
        // in the same order now, and `notes` is absent rather than `notes: []`.
        expect(Object.keys(envelopeOfCall(writerAgent.messages, 'c1'))).toEqual([
            'agent',
            'content',
            'contentLength',
            'offset',
            'limit',
            'truncated',
            'invocationId',
            'threadId',
            'status',
            'durationMs'
        ]);
    });

    it('names every miss once, in the order it was written, beside the names that do resolve', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: scripted([answer('mixed')], childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"review src/a.ts","scope":{"tools":["nope","read","red","nope"]}}'), answer('final')])
        });

        await writer('go');

        // A duplicate and a misspelling change nothing about the grant.
        expect(declaredNames(childSeen[0])).toEqual(['toolRequest', 'read']);

        expect(envelopeOfCall(writerAgent.messages, 'c1').notes).toEqual([
            'scope.tools named "nope", "red": this harness has no tool by those names, so nothing is granted for them. The child\'s scope is the names that do resolve: "read". Check the spelling against the toolRequest catalogue.'
        ]);
    });

    it('names the miss when the allowlist resolves to nothing at all', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: scripted([answer('reasoned')], childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"think about src/a.ts","scope":{"tools":["red"]}}'), answer('final')])
        });

        await writer('go');

        // The child is a pure-reasoning child — the same shape an EMPTY allowlist produces — so
        // the note must not claim it was granted anything.
        expect(declaredNames(childSeen[0])).toEqual(['toolRequest']);

        expect(envelopeOfCall(writerAgent.messages, 'c1').notes).toEqual([
            'scope.tools named "red": this harness has no tool by that name, so nothing is granted for it. This child was scoped to no tool that resolves. Check the spelling against the toolRequest catalogue.'
        ]);
    });

    it('treats toolRequest as recognised, because no allowlist can ever close that door', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: scripted([answer('asked')], childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"think about src/a.ts","scope":{"tools":["toolRequest"]}}'), answer('final')])
        });

        await writer('go');

        expect(declaredNames(childSeen[0])).toEqual(['toolRequest']);
        expect(envelopeOfCall(writerAgent.messages, 'c1')).not.toHaveProperty('notes');
    });

    it('names the miss on a child that never answered too — the unfinished envelope carries it', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: neverAnswers(childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"find facts","maxTurns":1,"scope":{"tools":["red"]}}'), answer('final')])
        });

        await writer('go');

        // The typo did not narrow or widen the child's toolbox: `peek` was already out of scope
        // before `red` was ever considered, and the run still consumed exactly one model request.
        expect(declaredNames(childSeen[0])).toEqual(['toolRequest']);
        expect(childSeen).toHaveLength(1);

        const envelope = envelopeOfCall(writerAgent.messages, 'c1');

        expect(envelope.status).toBe('failed');
        expect(envelope.notes).toEqual([
            'scope.tools named "red": this harness has no tool by that name, so nothing is granted for it. This child was scoped to no tool that resolves. Check the spelling against the toolRequest catalogue.'
        ]);
        expect(envelope.error).toBe(
            'Agent "researcher" requested tools on its single model turn without answering, the maxTurns this run was given (1). maxTurns caps model REQUESTS, not tool rounds, and the child\'s answer has to be one of them, so N turns allow at most N-1 tool rounds: 1 turn = 0 tool rounds — at maxTurns: 1 a child gets no tool round at all, and must answer without calling one.'
        );
    });
});

describe('a maxTurns failure names the N => N-1 arithmetic (F8)', () => {
    it('says that maxTurns: 1 leaves a child zero tool rounds', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: neverAnswers(childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"find facts","maxTurns":1}'), answer('final')])
        });

        await writer('go');

        // SEMANTICS UNTOUCHED: one model request, and the child's answer would have had to be it.
        expect(childSeen).toHaveLength(1);

        const envelope = envelopeOfCall(writerAgent.messages, 'c1');

        expect(envelope.status).toBe('failed');
        expect(envelope.partialContent).toBe('pass 1');
        expect(envelope.cancelledAtMessage).toBe(3);

        expect(envelope.error).toBe(
            'Agent "researcher" requested tools on its single model turn without answering, the maxTurns this run was given (1). maxTurns caps model REQUESTS, not tool rounds, and the child\'s answer has to be one of them, so N turns allow at most N-1 tool rounds: 1 turn = 0 tool rounds — at maxTurns: 1 a child gets no tool round at all, and must answer without calling one.'
        );
    });

    it('does the arithmetic for a larger cap and names the turn the answer had to land on', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: neverAnswers(childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"find facts","maxTurns":2}'), answer('final')])
        });

        await writer('go');

        // Exactly two model requests: the bound still counts requests, not rounds.
        expect(childSeen).toHaveLength(2);

        expect(envelopeOfCall(writerAgent.messages, 'c1').error).toBe(
            'Agent "researcher" requested tools on all 2 model turns without answering, the maxTurns this run was given (2). maxTurns caps model REQUESTS, not tool rounds, and the child\'s answer has to be one of them, so N turns allow at most N-1 tool rounds: 2 turns = 1 tool round, and its answer had to land on turn 2.'
        );
    });

    it('keeps the harness-wide maxIterations sentence byte-for-byte, which names no arithmetic', async () => {
        const childSeen: HarnessStreamRequest[] = [];
        const { writer, writerAgent } = pair({
            child: neverAnswers(childSeen),
            parent: scripted([delegateCall('{"agent":"researcher","input":"find facts"}'), answer('final')]),
            maxIterations: 2
        });

        await writer('go');

        expect(childSeen).toHaveLength(2);

        // The bound here belongs to the host and a model cannot widen it, so the only actionable
        // fact is the number — and the sentence that has always said that still says exactly it.
        expect(envelopeOfCall(writerAgent.messages, 'c1').error).toBe(
            'Agent "researcher" requested tools on all 2 model turns without answering.'
        );
    });
});
