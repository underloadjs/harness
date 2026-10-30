// Shared result-block projection and reference helpers (T4 R2).
//
// Pure functions only: events are constructed literally, so every label, status,
// content, and composed prompt string is asserted EXACTLY. No DOM, no server, no
// provider: this is the contract the server and the browser both consume.

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import {
    AGENT_REFERENCE_LABEL_PATTERN,
    MAX_AGENT_REFERENCES,
    MAX_REFERENCE_TOTAL_CHARS,
    REFERENCED_RESULTS_BUDGET_MESSAGE,
    REFERENCED_RESULTS_FOOTER,
    REFERENCED_RESULTS_HEADER,
    agentLabelParts,
    boundAgentResultContent,
    collectAgentLabelCounters,
    composeAgentResultPrompt,
    createAgentLabels,
    findAgentResultBlock,
    findLatestAgentResultBlock,
    listAgentResultBlocks,
    normalizeAgentLabel,
    parseAgentReferenceLabels,
    readAgentResultReferenceList
} from './agent-results';
import type { AgentResultTurn } from './agent-results';

const assistant = (content: string): Extract<HarnessEvent, { type: 'done' }>['message'] => ({
    role: 'assistant',
    content,
    reasoning: '',
    toolCalls: [],
    model: 'scripted/test',
    stopReason: 'stop'
});

// One root + one delegated child, in the exact emission order the harness uses.
const delegatedTurn = (status: AgentResultTurn['status'] = 'done'): AgentResultTurn => ({
    id: 'turn-1',
    status,
    events: [
        { type: 'start', agent: 'instruct', model: 'scripted/test' },
        {
            type: 'tool_call',
            agent: 'instruct',
            call: {
                id: 'call_1',
                name: 'agentDelegate',
                arguments: '{"agent":"research","input":"find it"}'
            }
        },
        {
            type: 'start',
            agent: 'research',
            model: 'scripted/test',
            thread: { id: '2', callId: 'call_1', input: 'find it' }
        },
        { type: 'text', agent: 'research', delta: 'research answer', thread: { id: '2', callId: 'call_1' } },
        {
            type: 'done',
            agent: 'research',
            thread: { id: '2', callId: 'call_1' },
            message: assistant('research answer')
        },
        {
            type: 'tool_result',
            agent: 'instruct',
            name: 'agentDelegate',
            callId: 'call_1',
            content: '{"agent":"research","content":"research answer"}',
            isError: false
        },
        { type: 'text', agent: 'instruct', delta: 'final answer' },
        { type: 'done', agent: 'instruct', message: assistant('final answer') }
    ]
});

describe('createAgentLabels', () => {
    it('uses ASCII letters, per-CODE occurrence counting, and the AG fallback', () => {
        const labels = createAgentLabels();

        expect(labels.next('instruct')).toBe('IT1');
        expect(labels.next('research')).toBe('RH1');
        // Same two-letter code, different full names: share one sequence so labels
        // can never collide (the T7 defect).
        expect(labels.next('rhesearch')).toBe('RH2');
        expect(labels.next('research')).toBe('RH3');
        expect(labels.next('INSTRUCT ')).toBe('IT2');

        // Digits in a name are ignored, so the grammar stays [A-Z]{2}\d+.
        expect(labels.next('agent1')).toBe('AT1');
        expect(labels.next('a1')).toBe('AA1');
        expect(labels.next('123')).toBe('AG1');

        // No ASCII letters: one shared fallback sequence.
        expect(labels.next('???')).toBe('AG2');
        expect(labels.next(undefined)).toBe('AG3');

        labels.reset();
        expect(labels.next('instruct')).toBe('IT1');
    });

    it('continues a sequence through seed() and never lowers a counter', () => {
        const first = createAgentLabels();
        expect(first.next('researcher')).toBe('RR1');

        // The detached snapshot is the seed a later turn continues from.
        const snapshot = first.counters();
        expect(snapshot).toEqual(new Map([['RR', 1]]));

        const second = createAgentLabels(snapshot);
        expect(second.next('researcher')).toBe('RR2');

        // A lower seed cannot renumber a label that was already minted.
        second.seed(new Map([['RR', 1]]));
        expect(second.next('researcher')).toBe('RR3');

        // reset() drops the seed; re-seeding the tile's frozen base reproduces the
        // exact label a rebuilt projection must show again (R6).
        second.reset();
        second.seed(snapshot);
        expect(second.next('researcher')).toBe('RR2');
    });
});

describe('listAgentResultBlocks', () => {
    it('projects the root and nested blocks with recorded done content', () => {
        expect(listAgentResultBlocks([delegatedTurn()])).toEqual([
            {
                turnId: 'turn-1',
                label: 'IT1',
                agent: 'instruct',
                status: 'done',
                content: 'final answer'
            },
            {
                turnId: 'turn-1',
                threadId: '2',
                label: 'RH1',
                agent: 'research',
                status: 'done',
                content: 'research answer'
            }
        ]);
    });

    it('marks a failed child error and keeps the root outcome authoritative', () => {
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'instruct', model: 'scripted/test' },
            {
                type: 'tool_call',
                agent: 'instruct',
                call: {
                    id: 'call_9',
                    name: 'agentDelegate',
                    arguments: '{"agent":"research","input":"fail"}'
                }
            },
            {
                type: 'start',
                agent: 'research',
                model: 'scripted/test',
                thread: { id: '7', callId: 'call_9', input: 'fail' }
            },
            {
                type: 'error',
                agent: 'research',
                error: { message: 'child exploded' },
                thread: { id: '7', callId: 'call_9' }
            },
            {
                type: 'tool_result',
                agent: 'instruct',
                name: 'agentDelegate',
                callId: 'call_9',
                content: 'child exploded',
                isError: true
            },
            {
                type: 'tool_result',
                agent: 'instruct',
                name: 'agentDelegate',
                callId: 'call_9',
                content: 'ignored duplicate',
                isError: false
            },
            { type: 'error', agent: 'instruct', error: { message: 'root failed' } }
        ];

        expect(listAgentResultBlocks([{ id: 'turn-2', status: 'error', events }])).toEqual([
            {
                turnId: 'turn-2',
                label: 'IT1',
                agent: 'instruct',
                status: 'error'
            },
            {
                turnId: 'turn-2',
                threadId: '7',
                label: 'RH1',
                agent: 'research',
                status: 'error'
            }
        ]);
    });

    it('closes an unfinished child with the terminal turn status and hides partial content', () => {
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'instruct', model: 'scripted/test' },
            {
                type: 'start',
                agent: 'research',
                model: 'scripted/test',
                thread: { id: '3', callId: 'call_3', input: 'go' }
            },
            { type: 'text', agent: 'research', delta: 'partial', thread: { id: '3', callId: 'call_3' } },
            { type: 'done', agent: 'instruct', message: assistant('root answer') }
        ];

        expect(listAgentResultBlocks([{ id: 'turn-3', status: 'cancelled', events }])).toEqual([
            {
                turnId: 'turn-3',
                label: 'IT1',
                agent: 'instruct',
                status: 'cancelled'
            },
            {
                turnId: 'turn-3',
                threadId: '3',
                label: 'RH1',
                agent: 'research',
                status: 'cancelled'
            }
        ]);
    });

    it('returns no blocks for a queued turn with no events', () => {
        expect(listAgentResultBlocks([{ id: 'turn-4', status: 'queued', events: [] }])).toEqual([]);
    });

    it('keeps a legacy no-thread child as one inline block per agent', () => {
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'lead', model: 'scripted/test' },
            { type: 'start', agent: 'helper', model: 'scripted/test' },
            { type: 'text', agent: 'helper', delta: 'legacy helper' },
            {
                type: 'done',
                agent: 'helper',
                message: assistant('legacy helper')
            },
            { type: 'done', agent: 'lead', message: assistant('lead answer') }
        ];

        expect(listAgentResultBlocks([{ id: 'turn-5', status: 'done', events }])).toEqual([
            {
                turnId: 'turn-5',
                label: 'LD1',
                agent: 'lead',
                status: 'done',
                content: 'lead answer'
            },
            {
                turnId: 'turn-5',
                threadId: 'inline:helper',
                label: 'HR1',
                agent: 'helper',
                status: 'done',
                content: 'legacy helper'
            }
        ]);
    });
});

describe('reference lookup', () => {
    const turns = [
        delegatedTurn(),
        {
            id: 'turn-2',
            status: 'done' as const,
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test' },
                { type: 'done', agent: 'instruct', message: assistant('second answer') }
            ]
        }
    ];

    it('finds an exact root/nested block by turn, thread and label', () => {
        expect(findAgentResultBlock(turns, { turnId: 'turn-1', label: 'IT1' })).toEqual({
            turnId: 'turn-1',
            label: 'IT1',
            agent: 'instruct',
            status: 'done',
            content: 'final answer'
        });
        expect(findAgentResultBlock(turns, { turnId: 'turn-1', threadId: '2', label: 'RH1' })).toEqual({
            turnId: 'turn-1',
            threadId: '2',
            label: 'RH1',
            agent: 'research',
            status: 'done',
            content: 'research answer'
        });
        // A stale/incorrect runtime or synthetic id matches nothing.
        expect(findAgentResultBlock(turns, { turnId: 'turn-1', threadId: 'ghost', label: 'RH1' })).toBeUndefined();
        expect(findAgentResultBlock(turns, { turnId: 'nope', label: 'IT1' })).toBeUndefined();
    });

    it('resolves the stable call alias before AND after delegation adoption', () => {
        const pending: AgentResultTurn = {
            id: 'turn-pending',
            status: 'running',
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test' },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    call: {
                        id: 'call_7',
                        name: 'agentDelegate',
                        arguments: '{"agent":"research","input":"later"}'
                    }
                }
            ]
        };

        // Before the child start, the UI-visible identity is call:<callId>.
        expect(listAgentResultBlocks([pending])[1]).toEqual({
            turnId: 'turn-pending',
            threadId: 'call:call_7',
            label: 'RH1',
            agent: 'research',
            status: 'running'
        });
        expect(
            findAgentResultBlock([pending], { turnId: 'turn-pending', threadId: 'call:call_7', label: 'RH1' })
        ).toEqual(expect.objectContaining({ label: 'RH1', status: 'running' }));

        // After adoption the descriptor reports the runtime id, but the OLD bound
        // alias still resolves (a reference captured while pending).
        expect(
            findAgentResultBlock([delegatedTurn()], { turnId: 'turn-1', threadId: 'call:call_1', label: 'RH1' })
        ).toEqual({
            turnId: 'turn-1',
            threadId: '2',
            label: 'RH1',
            agent: 'research',
            status: 'done',
            content: 'research answer'
        });

        // A reference bound WITHOUT a thread id (the pre-alias legacy shape) still
        // resolves to the single matching nested block after adoption.
        expect(findAgentResultBlock([delegatedTurn()], { turnId: 'turn-1', label: 'RH1' })).toEqual({
            turnId: 'turn-1',
            threadId: '2',
            label: 'RH1',
            agent: 'research',
            status: 'done',
            content: 'research answer'
        });
    });

    it('resolves an inline:<agent> alias and a threadless legacy binding', () => {
        const legacy: AgentResultTurn = {
            id: 'turn-legacy',
            status: 'done',
            events: [
                { type: 'start', agent: 'lead', model: 'scripted/test' },
                { type: 'start', agent: 'helper', model: 'scripted/test' },
                { type: 'done', agent: 'helper', message: assistant('legacy helper') },
                { type: 'done', agent: 'lead', message: assistant('lead answer') }
            ]
        };

        expect(
            findAgentResultBlock([legacy], { turnId: 'turn-legacy', threadId: 'inline:helper', label: 'HR1' })
        ).toEqual({
            turnId: 'turn-legacy',
            threadId: 'inline:helper',
            label: 'HR1',
            agent: 'helper',
            status: 'done',
            content: 'legacy helper'
        });
        // A descriptor produced before aliases existed carried no threadId. It can
        // still resolve to the ONE matching nested block.
        expect(findAgentResultBlock([legacy], { turnId: 'turn-legacy', label: 'HR1' })).toEqual({
            turnId: 'turn-legacy',
            threadId: 'inline:helper',
            label: 'HR1',
            agent: 'helper',
            status: 'done',
            content: 'legacy helper'
        });
        // …but an incorrect explicit id is never repaired.
        expect(
            findAgentResultBlock([legacy], { turnId: 'turn-legacy', threadId: 'inline:other', label: 'HR1' })
        ).toBeUndefined();
    });

    it('resolves a typed label to the one conversation-scoped block it names', () => {
        // turn-2's `instruct` root is IT2, not a second IT1: numbering spans the
        // conversation, so a label always names exactly one block (R5/R6).
        expect(findLatestAgentResultBlock(turns, '#it1')?.content).toBe('final answer');
        expect(findLatestAgentResultBlock(turns, 'it2')?.content).toBe('second answer');
        expect(findLatestAgentResultBlock(turns, 'rh1')?.threadId).toBe('2');
        expect(findLatestAgentResultBlock(turns, 'rh2')).toBeUndefined();
        expect(findLatestAgentResultBlock(turns, 'ZZ9')).toBeUndefined();
    });

    it('numbers distinct threads of one agent RR1/RR2 across turns (R5/R6)', () => {
        // The user's defect: two Researcher threads both showing `RR1`. Numbering
        // spans the conversation, so the second turn continues the code sequence and
        // a label still names exactly one block.
        const researcherTurn = (id: string, answerText: string): AgentResultTurn => ({
            id,
            status: 'done',
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test' },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    call: {
                        id: `call-${id}`,
                        name: 'agentDelegate',
                        arguments: '{"agent":"researcher","input":"look"}'
                    }
                },
                {
                    type: 'start',
                    agent: 'researcher',
                    model: 'scripted/test',
                    thread: { id: `t-${id}`, callId: `call-${id}`, input: 'look' }
                },
                {
                    type: 'done',
                    agent: 'researcher',
                    thread: { id: `t-${id}`, callId: `call-${id}` },
                    message: assistant(answerText)
                },
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'agentDelegate',
                    callId: `call-${id}`,
                    content: answerText,
                    isError: false
                },
                { type: 'done', agent: 'instruct', message: assistant(`done ${id}`) }
            ]
        });

        const twoTurns = [researcherTurn('turn-a', 'first'), researcherTurn('turn-b', 'second')];

        // Distinct threads, distinct stable labels — never two RR1s.
        expect(
            listAgentResultBlocks(twoTurns).map((block) => `${block.label}:${block.threadId ?? 'root'}`)
        ).toEqual(['IT1:root', 'RR1:t-turn-a', 'IT2:root', 'RR2:t-turn-b']);

        expect(findLatestAgentResultBlock(twoTurns, '#RR1')?.content).toBe('first');
        expect(findLatestAgentResultBlock(twoTurns, '#RR2')?.content).toBe('second');
        // The later turn's binding resolves its OWN thread, not a restart at RR1.
        expect(
            findAgentResultBlock(twoTurns, { turnId: 'turn-b', threadId: 't-turn-b', label: 'RR2' })
        ).toEqual({
            turnId: 'turn-b',
            threadId: 't-turn-b',
            label: 'RR2',
            agent: 'researcher',
            status: 'done',
            content: 'second'
        });
        expect(
            findAgentResultBlock(twoTurns, { turnId: 'turn-b', threadId: 't-turn-b', label: 'RR1' })
        ).toBeUndefined();
    });
});

describe('conversation labels (R8)', () => {
    // A host-thread run carries a metadata-only thread frame on every event. It is
    // the TURN'S conversation, not a child, so its root block takes the turn's
    // persistent label and never mints an extra occurrence.
    const hostTurn = (id: string, threadLabel: string, content: string): AgentResultTurn => ({
        id,
        status: 'done',
        threadLabel,
        events: [
            { type: 'start', agent: 'Researcher', model: 'scripted/test', thread: { id: `inv-${id}`, input: id } },
            { type: 'text', agent: 'Researcher', delta: content, thread: { id: `inv-${id}` } },
            { type: 'done', agent: 'Researcher', thread: { id: `inv-${id}` }, message: assistant(content) }
        ]
    });

    it('reuses the conversation label across runs instead of numbering invocations', () => {
        const turns = [hostTurn('turn-1', 'RR2', 'first'), hostTurn('turn-2', 'RR2', 'second')];

        expect(
            listAgentResultBlocks(turns).map((block) => `${block.label}:${block.threadId ?? 'root'}:${block.content}`)
        ).toEqual(['RR2:root:first', 'RR2:root:second']);
        // Typed `#RR2` resolves the latest response of that SAME conversation.
        expect(findLatestAgentResultBlock(turns, '#RR2')?.content).toBe('second');
    });

    it('names a nested child block with the CHILD conversation label', () => {
        const turn: AgentResultTurn = {
            id: 'turn-4',
            status: 'done',
            threadLabel: 'RR4',
            threadLabels: { 'inv-child': 'RR5' },
            events: [
                { type: 'start', agent: 'Researcher', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
                {
                    type: 'tool_call',
                    agent: 'Researcher',
                    thread: { id: 'inv-root' },
                    call: {
                        id: 'call_1',
                        name: 'agentDelegate',
                        arguments: '{"agent":"Helper","input":"child"}'
                    }
                },
                {
                    type: 'start',
                    agent: 'Helper',
                    model: 'scripted/test',
                    thread: { id: 'inv-child', parentId: 'inv-root', callId: 'call_1', input: 'child' }
                },
                {
                    type: 'done',
                    agent: 'Helper',
                    thread: { id: 'inv-child', parentId: 'inv-root', callId: 'call_1' },
                    message: assistant('child answer')
                },
                { type: 'tool_result', agent: 'Researcher', name: 'agentDelegate', callId: 'call_1', content: 'ok', isError: false },
                { type: 'done', agent: 'Researcher', thread: { id: 'inv-root' }, message: assistant('root answer') }
            ]
        };

        expect(listAgentResultBlocks([turn]).map((block) => `${block.label}:${block.threadId ?? 'root'}`)).toEqual([
            'RR4:root',
            'RR5:inv-child'
        ]);
    });
});

describe('parseAgentReferenceLabels', () => {
    it('extracts only exact label tokens, unique and in order', () => {
        expect(
            parseAgentReferenceLabels(
                'Use #IT1 then (#rh2). Not #1234, not #Intro, but #IT10 and repeat #IT1.'
            )
        ).toEqual(['IT1', 'RH2', 'IT10']);
    });

    it('ignores a token without a boundary', () => {
        expect(parseAgentReferenceLabels('word#IT1 x#IT2')).toEqual([]);
    });
});

describe('readAgentResultReferenceList', () => {
    it('accepts the wire shape and normalises labels', () => {
        expect(
            readAgentResultReferenceList([
                { turnId: 't1', label: '#it1' },
                { turnId: 't1', threadId: '2', label: 'rh1' }
            ])
        ).toEqual([
            { turnId: 't1', label: 'IT1' },
            { turnId: 't1', threadId: '2', label: 'RH1' }
        ]);
        expect(readAgentResultReferenceList(undefined)).toBeUndefined();
        expect(readAgentResultReferenceList([])).toEqual([]);
    });

    it('rejects malformed payloads with a clear TypeError', () => {
        expect(() => readAgentResultReferenceList({ turnId: 't1', label: 'IT1' })).toThrow(
            new TypeError('references must be an array.')
        );
        expect(() => readAgentResultReferenceList([{ turnId: '', label: 'IT1' }])).toThrow(
            new TypeError('references[0].turnId must be a non-empty string.')
        );
        expect(() => readAgentResultReferenceList([{ turnId: 't1', threadId: '', label: 'IT1' }])).toThrow(
            new TypeError('references[0].threadId must be a non-empty string when present.')
        );
        expect(() => readAgentResultReferenceList([{ turnId: 't1', label: 'nope' }])).toThrow(
            new TypeError('references[0].label must be a block label such as "IT1".')
        );
        expect(() =>
            readAgentResultReferenceList([
                { turnId: 't1', label: 'IT1' },
                { turnId: 't1', label: 'RH1' }
            ])
        ).toThrow(new TypeError('references[1] duplicates turn "t1" with the same thread.'));
        expect(() =>
            readAgentResultReferenceList(
                Array.from({ length: MAX_AGENT_REFERENCES + 1 }, (_, index) => ({
                    turnId: `t${index}`,
                    label: 'IT1'
                }))
            )
        ).toThrow(
            new TypeError(`references cannot contain more than ${MAX_AGENT_REFERENCES} entries.`)
        );
    });
});

describe('reference prompt composition', () => {
    it('returns the raw prompt by identity when nothing is referenced', () => {
        const prompt = 'fresh task';
        expect(composeAgentResultPrompt(prompt, [])).toBe(prompt);
    });

    it('appends clearly delimited referenced content after the user prompt', () => {
        expect(
            composeAgentResultPrompt('summarise #IT1', [
                {
                    block: {
                        turnId: 'turn-1',
                        label: 'IT1',
                        agent: 'instruct',
                        status: 'done',
                        content: 'final answer'
                    },
                    content: 'final answer'
                },
                {
                    block: {
                        turnId: 'turn-1',
                        threadId: '2',
                        label: 'RH1',
                        agent: 'research',
                        status: 'done',
                        content: 'research answer'
                    },
                    content: 'research answer'
                }
            ])
        ).toBe(
            [
                'summarise #IT1',
                '',
                REFERENCED_RESULTS_HEADER,
                '--- #IT1 | agent instruct | turn turn-1 ---',
                'final answer',
                '--- end #IT1 ---',
                '--- #RH1 | agent research | turn turn-1 | thread 2 ---',
                'research answer',
                '--- end #RH1 ---',
                REFERENCED_RESULTS_FOOTER
            ].join('\n')
        );
    });

    it('bounds oversized content with an explicit marker INSIDE the limit', () => {
        const content = 'a'.repeat(50);
        const marker = '\n...[truncated 39 characters]';
        const bounded = boundAgentResultContent(content, 40);

        expect(bounded).toBe('a'.repeat(11) + marker);
        expect(bounded.length).toBe(40);
        expect(boundAgentResultContent('abc', 3)).toBe('abc');
        // Too small even for the notice: no unmarked content is emitted.
        expect(boundAgentResultContent('abc', 2)).toBe('');
    });

    it('keeps a truncated composition at exactly the combined 200k budget', () => {
        const prompt = 'x'.repeat(199_700);
        const content = 'r'.repeat(5_000);
        const result = composeAgentResultPrompt(prompt, [
            {
                block: {
                    turnId: 'turn-1',
                    label: 'IT1',
                    agent: 'instruct',
                    status: 'done',
                    content
                },
                content
            }
        ]);

        // The raw prompt is preserved verbatim, and the TOTAL never exceeds the
        // combined ceiling. A truncated block fills the remaining space exactly.
        expect(result.slice(0, prompt.length)).toBe(prompt);
        expect(result.length).toBe(MAX_REFERENCE_TOTAL_CHARS);
        expect(result.startsWith(`${prompt}\n\n${REFERENCED_RESULTS_HEADER}\n--- #IT1 | agent instruct | turn turn-1 ---\n`)).toBe(true);
        expect(result.endsWith(`--- end #IT1 ---\n${REFERENCED_RESULTS_FOOTER}`)).toBe(true);
        expect(result).toContain('\n...[truncated ');
    });

    it('rejects when the raw prompt leaves no capacity for a reference', () => {
        const entry = {
            block: {
                turnId: 'turn-1',
                label: 'IT1',
                agent: 'instruct' as const,
                status: 'done' as const,
                content: 'answer'
            },
            content: 'answer'
        };

        expect(() => composeAgentResultPrompt('x'.repeat(MAX_REFERENCE_TOTAL_CHARS), [entry])).toThrow(
            new Error(REFERENCED_RESULTS_BUDGET_MESSAGE)
        );
    });
});

describe('label pattern', () => {
    it('normalises a label and rejects non-labels', () => {
        expect(normalizeAgentLabel(' #it1 ')).toBe('IT1');
        expect(normalizeAgentLabel('ag12')).toBe('AG12');
        expect(normalizeAgentLabel('1234')).toBeUndefined();
        expect(normalizeAgentLabel('intro')).toBeUndefined();
        expect(AGENT_REFERENCE_LABEL_PATTERN.test('IT1')).toBe(true);
        expect(AGENT_REFERENCE_LABEL_PATTERN.test('IT')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R6 deletion-safe labels + host-thread root routing
// ---------------------------------------------------------------------------

// One ROOT turn of the `probe` agent (code PE), optionally with recorded seeds.
const rootTurn = (
    id: string,
    content: string,
    labels?: Readonly<Record<string, number>>
): AgentResultTurn => ({
    id,
    status: 'done',
    ...(labels === undefined ? {} : { labels }),
    events: [
        { type: 'start', agent: 'probe', model: 'scripted/test' },
        { type: 'text', agent: 'probe', delta: content },
        { type: 'done', agent: 'probe', message: assistant(content) }
    ]
});

describe('deletion-safe label seeds', () => {
    it('collects the counters a NEXT turn starts from', () => {
        const turns = [rootTurn('turn-1', 'one'), rootTurn('turn-2', 'two')];

        expect([...collectAgentLabelCounters(turns)]).toEqual([['PE', 2]]);
        expect([...collectAgentLabelCounters([])]).toEqual([]);
    });

    it('honours a recorded seed so a surviving turn keeps its label', () => {
        // Recorded conversation: turn-1 is PE1, turn-2 is PE2 (seed says PE was
        // already used once when turn-2 started).
        const survivor = rootTurn('turn-2', 'two', { PE: 1 });

        // Projecting the survivor ALONE (its predecessor was deleted) still calls
        // it PE2 instead of renumbering it to PE1.
        expect(listAgentResultBlocks([survivor])).toEqual([
            { turnId: 'turn-2', label: 'PE2', agent: 'probe', status: 'done', content: 'two' }
        ]);

        // The identical history with no seed is the pre-deletion behaviour.
        expect(listAgentResultBlocks([rootTurn('turn-2', 'two')])[0].label).toBe('PE1');
    });

    it('never lowers an existing occurrence counter when a seed is applied', () => {
        const labels = createAgentLabels();
        expect(labels.next('probe')).toBe('PE1');
        labels.seed(new Map([['PE', 5]]));
        expect(labels.next('probe')).toBe('PE6');
        // A late, lower seed is ignored rather than rewinding the namespace.
        labels.seed(new Map([['PE', 2]]));
        expect(labels.next('probe')).toBe('PE7');
    });
});

describe('host-thread root routing', () => {
    it('projects a host-thread root identity as the turn ROOT, not a child block', () => {
        // The runtime attaches invocation identity to every frame of a HOST thread
        // run (no parent, no spawning call, no branch): it is the turn's own
        // conversation, so the block is the root (no `threadId`).
        const turn: AgentResultTurn = {
            id: 'turn-1',
            status: 'done',
            events: [
                {
                    type: 'start',
                    agent: 'probe',
                    model: 'scripted/test',
                    thread: { id: '1', input: 'hello' }
                },
                { type: 'text', agent: 'probe', delta: 'answer:hello', thread: { id: '1' } },
                {
                    type: 'done',
                    agent: 'probe',
                    message: assistant('answer:hello'),
                    thread: { id: '1' }
                }
            ]
        };

        expect(listAgentResultBlocks([turn])).toEqual([
            {
                turnId: 'turn-1',
                label: 'PE1',
                agent: 'probe',
                status: 'done',
                content: 'answer:hello'
            }
        ]);
    });

    it('still projects a delegated child under its invocation id', () => {
        const turn: AgentResultTurn = {
            id: 'turn-1',
            status: 'done',
            events: [
                {
                    type: 'start',
                    agent: 'probe',
                    model: 'scripted/test',
                    thread: { id: '1', input: 'hello' }
                },
                {
                    type: 'tool_call',
                    agent: 'probe',
                    call: {
                        id: 'call_1',
                        name: 'agentDelegate',
                        arguments: '{"agent":"research","input":"find it"}'
                    },
                    thread: { id: '1' }
                },
                {
                    type: 'start',
                    agent: 'research',
                    model: 'scripted/test',
                    thread: { id: '2', parentId: '1', callId: 'call_1', input: 'find it' }
                },
                {
                    type: 'done',
                    agent: 'research',
                    message: assistant('found it'),
                    thread: { id: '2', parentId: '1', callId: 'call_1' }
                },
                {
                    type: 'done',
                    agent: 'probe',
                    message: assistant('answer:hello'),
                    thread: { id: '1' }
                }
            ]
        };

        expect(listAgentResultBlocks([turn])).toEqual([
            {
                turnId: 'turn-1',
                label: 'PE1',
                agent: 'probe',
                status: 'done',
                content: 'answer:hello'
            },
            {
                turnId: 'turn-1',
                threadId: '2',
                label: 'RH1',
                agent: 'research',
                status: 'done',
                content: 'found it'
            }
        ]);
    });
});


// T14 (R8-R10): a conversation label is authoritative AND RESERVES its ordinal.
//
// The server records one stable label per persistent conversation (`RR4`) and the
// projector chains ONE per-code allocator across the turns. Adopting the label
// without reserving its number meant a nested block of the same code could be
// minted the very number the conversation already showed (`PE1` root + `PE1`
// child), and `collectAgentLabelCounters` did not report conversation labels at
// all, so the server's durable counters drifted from what the UI displayed.
describe('agentLabelParts', () => {
    it('splits a normalised label into code and positive ordinal', () => {
        // Uppercase spelling, the code, and the ordinal as a NUMBER.
        expect(agentLabelParts('RR1')).toEqual({ label: 'RR1', code: 'RR', ordinal: 1 });
        // The composer's typed spelling is normalised before parsing.
        expect(agentLabelParts(' #it1 ')).toEqual({ label: 'IT1', code: 'IT', ordinal: 1 });
        // The neutral fallback code is a label like any other.
        expect(agentLabelParts('ag12')).toEqual({ label: 'AG12', code: 'AG', ordinal: 12 });
    });

    it('rejects a zero ordinal and anything that is not a label', () => {
        // An ordinal is a COUNT: `RR0` can never be minted, so a persisted `RR0` is
        // corruption rather than a name.
        expect(agentLabelParts('RR0')).toBeUndefined();
        // Leading zeros are preserved in the TEXT and parsed as the same number.
        expect(agentLabelParts('RR01')).toEqual({ label: 'RR01', code: 'RR', ordinal: 1 });

        expect(agentLabelParts('1234')).toBeUndefined();
        expect(agentLabelParts('intro')).toBeUndefined();
        expect(agentLabelParts('T8')).toBeUndefined();
        expect(agentLabelParts('')).toBeUndefined();
        expect(agentLabelParts(7)).toBeUndefined();
        expect(agentLabelParts(undefined)).toBeUndefined();
    });
});

describe('explicit conversation labels reserve their ordinal', () => {
    // A host conversation's ROOT frame carries its thread id and nothing else, so
    // this turn's root block is the conversation itself.
    const conversationTurn = (threadLabel: string, content: string): AgentResultTurn => ({
        id: `turn-${threadLabel}`,
        status: 'done',
        threadLabel,
        events: [
            { type: 'start', agent: 'probe', model: 'scripted/test', thread: { id: '1' } },
            { type: 'done', agent: 'probe', message: assistant(content), thread: { id: '1' } }
        ]
    });

    it('adopts the recorded conversation label without minting a new number', () => {
        const turn = conversationTurn('PE4', 'four');

        // The label is authoritative: this block is the fourth conversation, not
        // "the first block of a fresh allocator".
        expect(listAgentResultBlocks([turn])).toEqual([
            {
                turnId: 'turn-PE4',
                label: 'PE4',
                agent: 'probe',
                status: 'done',
                content: 'four'
            }
        ]);

        // ...but the number is CONSUMED: the next turn of the code starts at 5.
        expect([...collectAgentLabelCounters([turn])]).toEqual([['PE', 4]]);
    });

    it('never gives a nested block of the same code the root conversation number', () => {
        const turn: AgentResultTurn = {
            id: 'turn-1',
            status: 'done',
            // Root conversation PE1; the nested child uses the SAME agent id code.
            threadLabel: 'PE1',
            events: [
                { type: 'start', agent: 'probe', model: 'scripted/test', thread: { id: '1' } },
                {
                    type: 'start',
                    agent: 'probe',
                    model: 'scripted/test',
                    thread: { id: 'thread-9', parentId: '1', input: 'nested' }
                },
                {
                    type: 'done',
                    agent: 'probe',
                    message: assistant('nested answer'),
                    thread: { id: 'thread-9', parentId: '1' }
                },
                { type: 'done', agent: 'probe', message: assistant('root answer'), thread: { id: '1' } }
            ]
        };

        // PE1 is reserved by the root, so the child is minted PE2 — a duplicate PE1
        // would make a typed `#PE1` ambiguous.
        expect(listAgentResultBlocks([turn])).toEqual([
            {
                turnId: 'turn-1',
                label: 'PE1',
                agent: 'probe',
                status: 'done',
                content: 'root answer'
            },
            {
                turnId: 'turn-1',
                threadId: 'thread-9',
                label: 'PE2',
                agent: 'probe',
                status: 'done',
                content: 'nested answer'
            }
        ]);

        expect([...collectAgentLabelCounters([turn])]).toEqual([['PE', 2]]);
    });

    it('chains the reservation across turns in both orders', () => {
        const labelled = conversationTurn('PE1', 'first');
        const legacy: AgentResultTurn = {
            id: 'turn-legacy',
            status: 'done',
            events: [
                { type: 'start', agent: 'probe', model: 'scripted/test' },
                { type: 'done', agent: 'probe', message: assistant('legacy answer') }
            ]
        };

        // Conversation first, legacy block after: the legacy block is PE2.
        expect(listAgentResultBlocks([labelled, legacy]).map((block) => block.label)).toEqual([
            'PE1',
            'PE2'
        ]);

        // Legacy block first (PE1), then a conversation recorded as PE3: both keep
        // their numbers and the high-water is the labelled ordinal.
        const late = conversationTurn('PE3', 'third');
        expect(listAgentResultBlocks([legacy, late]).map((block) => block.label)).toEqual([
            'PE1',
            'PE3'
        ]);
        expect([...collectAgentLabelCounters([legacy, late])]).toEqual([['PE', 3]]);

        // The exact lookup still resolves the legacy block by the number its
        // position in the chain gives it.
        expect(findAgentResultBlock([labelled, legacy], { turnId: 'turn-legacy', label: 'PE2' })).toEqual({
            turnId: 'turn-legacy',
            label: 'PE2',
            agent: 'probe',
            status: 'done',
            content: 'legacy answer'
        });
    });
});
