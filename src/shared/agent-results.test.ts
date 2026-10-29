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
    boundAgentResultContent,
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

    it('resolves a typed label to the latest matching turn', () => {
        expect(findLatestAgentResultBlock(turns, '#it1')?.content).toBe('second answer');
        expect(findLatestAgentResultBlock(turns, 'rh1')?.threadId).toBe('2');
        expect(findLatestAgentResultBlock(turns, 'ZZ9')).toBeUndefined();
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
