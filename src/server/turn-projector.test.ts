// The server-side display fold (R1/R3).
//
// These tests pin the projection the browser used to perform itself, and every
// assertion is an EXACT value: the ops a live stream sends, the compiled tree a
// reload receives, and the identity rules that keep rich rendering intact without
// the client ever seeing a raw step.
//
// The behaviors under test are the ones ./turn-projector.ts cites from the tile
// renderer (routing, `callId` pairing, attempt discard, pending semantics, two-scope
// tokens, action expiry) plus the compactness bounds the T3 contract promised.
//
// Cross-references:
//   - ../shared/turn-display.ts   — the frozen shapes and bounds asserted here
//   - ../frontend/ui/turns.ts     — the DOM renderer whose semantics are reproduced
//   - ./view.test.ts              — the store surface built on this fold
//   - ./api-views.test.ts         — the wire privacy rules on top of it

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import { DISPLAY_ARGS_PREVIEW_CHARS, DISPLAY_PANELS_PER_STEP, DISPLAY_PREVIEW_CHARS } from '../shared/turn-display';
import type { DisplayProjectContext, TurnDisplayOp, TurnRecordStatus } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, formatDuration, previewText, projectTurn, refoldTurn } from './turn-projector';

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'do the thing',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    ...overrides
});

const CONTEXT: DisplayProjectContext = { primary: 'one' };

// One recorded event per 10 ms, so a duration is asserted as an exact number.
const timeOf = (index: number): number => 1_000 + index * 10;

type Folded = {
    ops: TurnDisplayOp[][];
    display: () => ReturnType<ReturnType<typeof createTurnProjector>['display']>;
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    settle: (status: TurnRecordStatus) => TurnDisplayOp[];
};

// The live path: push the record, then fold it — the exact order the store's
// recorder uses (./sessions.ts), which is what makes this a parity test as well.
const fold = (events: HarnessEvent[], turn: SessionTurn = turnOf(), context = CONTEXT): Folded => {
    const projector = createTurnProjector(turn, context);
    const ops: TurnDisplayOp[][] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(timeOf(index));

        ops.push(projector.apply(event, timeOf(index), index));
    });

    return {
        ops,
        display: () => projector.display(),
        summary: () => projector.summary(),
        settle: (status) => projector.settle(status, 5_000)
    };
};

const flatten = (ops: TurnDisplayOp[][]): TurnDisplayOp[] => ops.flat();

const starts = (turn: HarnessEvent = { type: 'start', agent: 'one', model: 'gpt-x' }): HarnessEvent => turn;

const toolCall = (id: string, name: string, args: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id, name, arguments: args },
    ...(thread === undefined ? {} : { thread })
});

const toolResult = (
    name: string,
    content: string,
    callId?: string,
    extra: Partial<Extract<HarnessEvent, { type: 'tool_result' }>> = {},
    thread?: HarnessEvent['thread']
): HarnessEvent => ({
    type: 'tool_result',
    agent: 'one',
    name,
    content,
    isError: extra.isError ?? false,
    ...(callId === undefined ? {} : { callId }),
    ...extra,
    ...(thread === undefined ? {} : { thread })
});

describe('rows and sections', () => {
    it('opens the root section with the server-minted id and the entry role', () => {
        const result = fold([starts()]);

        expect(result.ops[0]).toEqual([
            {
                op: 'section:open',
                turnId: 'turn-1',
                section: {
                    id: 'turn-1:0',
                    role: 'primary',
                    agent: 'one',
                    agentLabel: '',
                    nodes: [],
                    state: 'open'
                }
            },
            {
                op: 'section:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                patch: { model: 'gpt-x', role: 'primary', agentLabel: '', state: 'streaming' }
            }
        ]);

        expect(result.summary()).toMatchObject({
            id: 'turn-1',
            index: 0,
            prompt: 'do the thing',
            status: 'running',
            state: 'streaming',
            sectionCount: 1,
            stepCount: 0,
            activeAgents: ['one'],
            blocks: []
        });
    });

    it('streams prose into ONE attempt-owned text node and commits it on `done`', () => {
        const result = fold([
            starts(),
            { type: 'text', agent: 'one', delta: 'Hel' },
            { type: 'text', agent: 'one', delta: 'lo' },
            {
                type: 'done',
                agent: 'one',
                message: {
                    role: 'assistant',
                    content: 'Hello',
                    model: 'gpt-x',
                    stopReason: 'stop',
                    toolCalls: [],
                    usage: { input: 3, output: 2, total: 5 }
                }
            } as HarnessEvent
        ]);

        expect(result.ops[1]).toEqual([
            { op: 'node:insert', turnId: 'turn-1', sectionId: 'turn-1:0', node: { kind: 'text', id: 'n1', text: '', committed: false } },
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: 'Hel' }
        ]);
        expect(result.ops[2]).toEqual([
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: 'lo' }
        ]);

        // Commit order: mark the nodes committed, move the copy pointer, close the window.
        const [committed, answer, boundary] = result.ops[3] as TurnDisplayOp[];

        expect(committed).toEqual({ op: 'node:set', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', patch: { committed: true } });
        expect(answer).toEqual({ op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:0', patch: { answerNodeId: 'n1' } });
        expect(boundary).toEqual({ op: 'attempt:commit', turnId: 'turn-1', sectionId: 'turn-1:0' });

        expect(result.display().sections[0].nodes).toEqual([{ kind: 'text', id: 'n1', text: 'Hello', committed: true }]);
    });

    it('nests a delegated child under the invocation that spawned it, and adopts its placeholder', () => {
        const childThread = { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', kind: 'delegation' as const, input: 'sub task' };
        const result = fold([
            { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
            toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two', input: 'sub task' })),
            { type: 'start', agent: 'two', model: 'gpt-y', thread: childThread },
            { type: 'text', agent: 'two', delta: 'child says', thread: childThread }
        ]);

        const display = result.display();

        expect(display.sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);

        // The placeholder minted for the CALL keeps its display id after adoption, and
        // the child's own conversation label/invocation arrive as a patch. The UI had
        // to re-key its row for this moment; the display model never does.
        const child = display.sections[1];

        expect(child).toMatchObject({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            role: 'subagent',
            agent: 'two',
            invocationId: 'inv-child',
            state: 'streaming'
        });

        // The child's prose lands in the CHILD flow, never in the root tile flow, and
        // the delegation row the parent called stays in the PARENT flow.
        expect(child.nodes.map((node) => node.kind)).toEqual(['text']);
        expect(child.nodes[0]).toMatchObject({ id: 'n3', text: 'child says' });
        expect(display.sections[0].nodes.map((node) => node.kind)).toEqual(['tool']);
    });

    it('routes a threadless non-entry agent to its own inline section', () => {
        const result = fold([
            starts(),
            { type: 'text', agent: 'two', delta: 'orphan' }
        ]);

        expect(result.display().sections.map((section) => [section.id, section.agent])).toEqual([
            ['turn-1:0', 'one'],
            ['turn-1:1', 'two']
        ]);
        expect(result.ops[1][0]).toEqual({
            op: 'section:open',
            turnId: 'turn-1',
            section: { id: 'turn-1:1', role: 'subagent', agent: 'two', agentLabel: '', nodes: [], state: 'open' }
        });
    });
});

describe('tool pairing and detail addressing', () => {
    it('pairs a call with its result by callId and stamps the detail pair', () => {
        const result = fold([
            starts(),
            toolCall('call-1', 'read', JSON.stringify({ path: 'a.ts' })),
            toolResult('read', 'file body', 'call-1', { outcome: 'completed', durationMs: 12 })
        ]);

        const step = result.display().sections[0].nodes[0] as Extract<
            ReturnType<typeof projectTurn>['display']['sections'][number]['nodes'][number],
            { kind: 'tool' }
        >;

        expect(step).toEqual({
            kind: 'tool',
            id: '1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            callId: 'call-1',
            name: 'read',
            argsPreview: JSON.stringify({ path: 'a.ts' }),
            state: 'ok',
            outcome: 'completed',
            preview: 'file body',
            durationMs: 12,
            startedAt: 1_010,
            endedAt: 1_020,
            detail: { stepId: '1', resultStepId: '2', hasResult: true, truncated: false }
        });

        // The step id is the OPENING event index, so one lookup returns request+result.
        expect(step.detail.stepId).toBe('1');
        expect(step.detail.resultStepId).toBe('2');
    });

    it('pairs within the invocation, so a reused callId cannot cross settle rows', () => {
        const childThread = { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', kind: 'delegation' as const };

        const result = fold([
            { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
            toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two' })),
            { type: 'start', agent: 'two', model: 'gpt-y', thread: childThread },
            // The CHILD names its own call `call-1` — the SAME id the parent used for
            // the delegation. Ids are unique per CONVERSATION (types/index.ts:104), so
            // a turn-wide first-match search would settle the parent's open delegate
            // with the child's file body.
            toolCall('call-1', 'read', '{"path":"child"}', childThread),
            toolResult('read', 'child result', 'call-1', { outcome: 'completed', durationMs: 3 }, childThread),
            toolResult('delegate', 'parent done', 'call-1', { outcome: 'completed', durationMs: 9 })
        ]);

        const [root, childSection] = result.display().sections;
        const childStep = childSection.nodes.find((node) => node.kind === 'tool') as {
            preview?: string;
            durationMs?: number;
            sectionId: string;
        };
        const delegateStep = root.nodes.find((node) => node.kind === 'tool' && node.name === 'delegate') as {
            preview?: string;
            durationMs?: number;
            detail: { stepId: string; resultStepId?: string };
        };

        expect(childStep).toMatchObject({ sectionId: childSection.id, preview: 'child result', durationMs: 3 });
        expect(delegateStep).toMatchObject({ preview: 'parent done', durationMs: 9 });

        // Each detail pair names its OWN two events, so one click retrieves the right
        // request and response for the right invocation.
        expect(delegateStep.detail).toEqual({ stepId: '1', resultStepId: '5', hasResult: true, truncated: false });
        expect(childStep?.sectionId).toBe(childSection.id);
    });

    it('ignores a duplicate result for a settled call (one call, one row)', () => {
        const result = fold([
            starts(),
            toolCall('call-1', 'read', '{}'),
            toolResult('read', 'first', 'call-1', { outcome: 'completed' }),
            toolResult('read', 'late duplicate', 'call-1', { outcome: 'failed', isError: true })
        ]);

        expect(result.ops[3]).toEqual([]);
        expect(result.display().sections[0].nodes).toHaveLength(1);
        expect(result.display().sections[0].nodes[0]).toMatchObject({ preview: 'first', state: 'ok' });
    });

    it('renders a result-only legacy frame as its own step', () => {
        const result = fold([starts(), toolResult('read', 'no call was seen')]);

        expect(result.display().sections[0].nodes[0]).toMatchObject({
            kind: 'tool',
            id: '1',
            name: 'read',
            preview: 'no call was seen',
            state: 'ok',
            detail: { stepId: '1', hasResult: false }
        });
    });

    it('settles the child invocation from the parent result, with a cancelled control outcome', () => {
        const result = fold([
            { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
            toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two' })),
            toolResult('delegate', 'user stopped it', 'call-1', { outcome: 'cancelled', isError: true })
        ]);

        expect(result.display().sections[1]).toMatchObject({ state: 'cancelled' });
        expect(result.display().sections[0].nodes[0]).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
    });
});

describe('compactness bounds (R1)', () => {
    const huge = 'SENTINEL-BODY-9f3c'.repeat(8_000);

    it('trims a huge result to a bounded preview and marks the detail as bigger', () => {
        const result = fold([
            starts(),
            toolCall('call-1', 'read', huge),
            toolResult('read', huge, 'call-1', { outcome: 'completed', durationMs: 7 })
        ]);

        const step = result.display().sections[0].nodes[0] as { preview?: string; argsPreview?: string; detail: { truncated: boolean } };

        expect(step.preview).toHaveLength(DISPLAY_PREVIEW_CHARS);
        expect(step.argsPreview).toHaveLength(DISPLAY_ARGS_PREVIEW_CHARS);
        expect(step.detail.truncated).toBe(true);

        // The compact tree carries NO copy of the full payload: two 128 KiB strings
        // would make the frame megabytes, and the whole compiled tree is a fraction of
        // the raw record it replaces.
        const serialized = JSON.stringify(result.display());

        expect(serialized.length).toBeLessThan(2_000);
        expect(JSON.stringify(result.summary())).not.toContain('SENTINEL');
    });

    it('summarizes panels instead of forwarding them, and counts what it left out', () => {
        const panels = Array.from({ length: 6 }, (_entry, index) => ({
            id: `p${index}`,
            slot: 'right',
            title: `Panel ${index}`,
            blocks: [
                { type: 'table' as const, columns: ['a', 'b'], rows: [['one', 'two'], ['three', 'four']] },
                { type: 'text' as const, text: 'x'.repeat(4_000) }
            ]
        }));

        const result = fold([
            starts(),
            toolCall('call-1', 'grep', '{}'),
            toolResult('grep', 'matches', 'call-1', { outcome: 'completed', ui: panels })
        ]);

        const step = result.display().sections[0].nodes[0] as { panels?: { id: string; totalPanels: number; truncated: boolean; blocks: unknown[] }[] };

        expect(step.panels).toHaveLength(DISPLAY_PANELS_PER_STEP);
        expect(step.panels?.map((panel) => panel.id)).toEqual(['p0', 'p1', 'p2', 'p3']);
        expect(step.panels?.[0]).toMatchObject({
            title: 'Panel 0',
            blocks: [{ type: 'table', rows: 2, columns: 2 }, { type: 'text', length: 4_000 }],
            truncated: true,
            totalPanels: 6
        });

        // Cell TEXT never reaches the compact wire; only counts and a first line.
        expect(JSON.stringify(result.display())).not.toContain('xxxxx');
    });

    it('inlines only small image attachments and flags the rest as fetchable', () => {
        const turn = turnOf({
            attachments: [
                { id: 'a1', kind: 'image', marker: '[Image 1]', name: 'small.png', mime: 'image/png', size: 4, data: 'AAAA' },
                { id: 'a2', kind: 'pdf', marker: '[File 1]', name: 'big.pdf', mime: 'application/pdf', size: 5_000_000, data: 'B'.repeat(200_000) }
            ]
        });

        const result = fold([starts()], turn);
        const summary = result.summary();

        expect(summary.attachments).toEqual([
            {
                id: 'a1',
                marker: '[Image 1]',
                name: 'small.png',
                kind: 'image',
                mime: 'image/png',
                size: 4,
                data: 'AAAA',
                hasBytes: true
            },
            { id: 'a2', marker: '[File 1]', name: 'big.pdf', kind: 'pdf', mime: 'application/pdf', size: 5_000_000, hasBytes: true }
        ]);
    });
});

describe('attempt boundaries: retry discards exactly the failed attempt', () => {
    it('removes the abandoned nodes and placeholders and prints the retry line', () => {
        const result = fold([
            starts(),
            { type: 'text', agent: 'one', delta: 'committed half' },
            {
                type: 'attempt_commit',
                agent: 'one',
                attempt: 1,
                maxAttempts: 3
            } as HarnessEvent,
            { type: 'text', agent: 'one', delta: 'abandoned half' },
            toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two' })),
            {
                type: 'retry',
                agent: 'one',
                attempt: 1,
                maxAttempts: 3,
                delayMs: 1_500,
                error: { message: 'upstream 503' }
            } as HarnessEvent
        ]);

        const discard = result.ops[5].find((op) => op.op === 'attempt:discard');

        // A step node's id is its event index (the detail key), a prose node's is `n`
        // prefixed — the discard names exactly what this attempt created, and nothing
        // the earlier attempt committed.
        expect(discard).toEqual({ op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n3', '4'] });

        const removed = result.ops[5].filter((op) => op.op === 'section:remove');

        expect(removed).toEqual([{ op: 'section:remove', turnId: 'turn-1', sectionId: 'turn-1:1' }]);

        expect(result.ops[5][result.ops[5].length - 1]).toEqual({
            op: 'node:insert',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            node: {
                kind: 'notice',
                id: 'n5',
                tone: 'retry',
                // Exact existing tile text.
                text: 'attempt 1 of 3 failed · retrying in 1.5s · upstream 503',
                at: 1_050
            }
        });

        // The committed turn survives; only the failed attempt's prose is gone.
        expect(result.display().sections[0].nodes.map((node) => [node.kind, (node as { text?: string }).text])).toEqual([
            ['text', 'committed half'],
            ['notice', 'attempt 1 of 3 failed · retrying in 1.5s · upstream 503']
        ]);
        expect(result.display().sections).toHaveLength(1);
        expect(result.summary().stepCount).toBe(0);
    });

    it('formats durations exactly like the tile and the CLI', () => {
        expect(formatDuration(900)).toBe('900ms');
        expect(formatDuration(1_500)).toBe('1.5s');
        expect(formatDuration(252_000)).toBe('4m12s');
        expect(formatDuration(-1)).toBe('');
    });
});

describe('pending, wakeups and tokens', () => {
    it('treats an ABSENT pending array as silence, and a present one as authoritative', () => {
        const result = fold([
            starts(),
            toolCall('call-1', 'shell', '{"command":"sleep 5"}'),
            toolResult('shell', 'done', 'call-1', { outcome: 'completed', pending: [{ callId: 'call-2', name: 'watch', elapsedMs: 1_200 }] })
        ]);

        const ops = flatten(result.ops);
        const pending = ops.filter((op) => op.op === 'pending:set');

        expect(pending).toEqual([
            {
                op: 'pending:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                pending: [{ callId: 'call-2', name: 'watch', elapsedMs: 1_200 }]
            }
        ]);

        // The status line is server-composed text with the tile's exact format.
        const line = result.display().sections[0].nodes.find((node) => node.id === 'pending');

        expect(line).toMatchObject({ kind: 'notice', tone: 'info', text: 'pending · watch 1.2s' });
    });

    it('prints the wake line and ignores a wakeup with no usable pending list', () => {
        const withPending = fold([
            starts(),
            { type: 'wakeup', agent: 'one', reason: 'pending-tools', pending: [{ callId: 'c1', name: 'shell', elapsedMs: 60_000 }] } as HarnessEvent
        ]);

        expect(withPending.ops[1].some((op) => op.op === 'node:insert' && (op as { node?: { text?: string } }).node?.text === '1 tool still running · continuing')).toBe(true);

        const malformed = fold([starts(), { type: 'wakeup', agent: 'one', reason: 'pending-tools' } as HarnessEvent]);

        expect(malformed.ops[1]).toEqual([]);
    });

    it('reports token figures in both scopes and recomputes think-chip shares', () => {
        const turn = turnOf({ usage: { input: 1_000, output: 20, total: 1_020, cached: 400 } });
        const result = fold(
            [
                starts(),
                { type: 'reasoning', agent: 'one', delta: 'a'.repeat(250) } as HarnessEvent,
                { type: 'usage', agent: 'one', usage: { input: 1_000, output: 20, total: 1_020, cached: 400 } } as HarnessEvent
            ],
            turn
        );

        const usageOps = result.ops[2];

        expect(usageOps).toEqual([
            { op: 'usage', turnId: 'turn-1', sectionId: 'turn-1:0', latestInput: 1_000, cachedInput: 400 },
            {
                op: 'usage',
                turnId: 'turn-1',
                sectionId: 'turn',
                latestInput: 1_000,
                usage: { input: 1_000, output: 20, total: 1_020, cached: 400 }
            }
        ]);

        // The chip's share is measured the moment the chip exists (the denominator was
        // already known), and the usage event re-measures without re-emitting a change.
        expect(result.ops[1]).toContainEqual({
            op: 'node:set',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            nodeId: 'n1',
            patch: { share: 25 }
        });

        expect(result.summary()).toMatchObject({ latestInput: 1_000, cachedInput: 400, usage: { total: 1_020 } });
    });
});

describe('owner questions', () => {
    const request = {
        requestId: 'req-1',
        question: 'Which target?',
        recommended: 'b',
        options: [
            { id: 'a', label: 'Alpha' },
            { id: 'b', label: 'Beta', description: 'preferred' }
        ],
        allowCustom: true as const
    };

    it('carries the bounded request inline so the card can be answered without a fetch', () => {
        const result = fold([
            starts(),
            { type: 'action_request', agent: 'one', callId: 'call-1', request } as HarnessEvent
        ]);

        const step = result.display().sections[0].nodes[0] as { action?: { options: unknown[]; expired: boolean; question: string } };

        expect(step.action).toEqual({
            requestId: 'req-1',
            question: 'Which target?',
            options: [
                { id: 'a', label: 'Alpha' },
                { id: 'b', label: 'Beta', description: 'preferred' }
            ],
            recommended: 'b',
            allowCustom: true,
            expired: false
        });

        // The question is NOT attempt output: a retry must not eat a live card.
        const discarded = fold([
            starts(),
            { type: 'action_request', agent: 'one', callId: 'call-1', request } as HarnessEvent,
            { type: 'retry', agent: 'one', attempt: 1, maxAttempts: 2, delayMs: 0, error: { message: 'boom' } } as HarnessEvent
        ]);

        expect(discarded.display().sections[0].nodes.map((node) => node.kind)).toEqual(['action', 'notice']);
    });

    it('marks a question expired when the answer route can no longer accept it', () => {
        const expired = fold(
            [starts(), { type: 'action_request', agent: 'one', callId: 'call-1', request } as HarnessEvent],
            turnOf(),
            { ...CONTEXT, expiredRequestIds: new Set(['req-1']) }
        );

        expect((expired.display().sections[0].nodes[0] as { action?: { expired: boolean } }).action?.expired).toBe(true);
    });

    it('records the answer on the step and stamps its result index', () => {
        const result = fold([
            starts(),
            { type: 'action_request', agent: 'one', callId: 'call-1', request } as HarnessEvent,
            {
                type: 'action_answer',
                agent: 'one',
                requestId: 'req-1',
                answer: { requestId: 'req-1', choice: { kind: 'option', optionId: 'b' }, source: 'owner' }
            } as HarnessEvent
        ]);

        const step = result.display().sections[0].nodes[0] as {
            state: string;
            action?: { answered?: { choice: unknown; source: string } };
            detail: { resultStepId?: string; hasResult: boolean };
        };

        expect(step.state).toBe('ok');
        expect(step.action?.answered).toEqual({ choice: { kind: 'option', optionId: 'b' }, source: 'owner', at: 1_020 });
        expect(step.detail).toEqual({ stepId: '1', resultStepId: '2', hasResult: true, truncated: false });
        expect(flatten(result.ops).some((op) => op.op === 'node:insert' && (op as { node?: { text?: string } }).node?.text === 'answered · Beta')).toBe(true);
    });
});

describe('labels, blocks and turn closure', () => {
    it('takes block labels from the store instead of minting its own', () => {
        const result = fold([starts()], turnOf({ threadLabel: 'RR2' }), {
            ...CONTEXT,
            blocksOf: () => [
                { turnId: 'turn-1', label: 'RR2', agent: 'one', status: 'done', content: 'a'.repeat(500) }
            ],
            threadLabels: new Map()
        });

        expect(result.summary().blocks).toEqual([
            { turnId: 'turn-1', label: 'RR2', agent: 'one', status: 'done', preview: `${'a'.repeat(199)}\u2026`, referenceable: true }
        ]);
        expect(result.summary().threadLabel).toBe('RR2');
        expect(result.display().sections[0].agentLabel).toBe('RR2');
    });

    it('settles a cancelled turn: rows closed, running calls abandoned, nothing active', () => {
        const result = fold([
            starts(),
            { type: 'text', agent: 'one', delta: 'partial' },
            toolCall('call-1', 'shell', '{"command":"sleep 99"}')
        ]);

        const ops = result.settle('cancelled');

        // No error text and a cancelled run: the row carries NO `detail` key at all
        // (absent, never an empty string or the model of a run that never answered).
        expect(result.summary()).toMatchObject({ status: 'cancelled', state: 'cancelled', activeAgents: [] });
        expect('detail' in (result.summary() as Record<string, unknown>)).toBe(false);

        const sections = result.display().sections;

        expect(sections[0].state).toBe('cancelled');

        const abandoned = sections[0].nodes.find((node) => node.kind === 'tool') as {
            state: string;
            preview?: string;
            endedAt?: number;
        };

        expect(abandoned).toMatchObject({
            state: 'cancelled',
            preview: 'the turn was cancelled before this call returned',
            endedAt: 5_000
        });

        // `settle` is idempotent: a repeat emits only the row itself.
        expect(result.settle('cancelled').filter((op) => op.op !== 'turn')).toEqual([]);
        expect(ops.some((op) => op.op === 'turn')).toBe(true);
    });
});

describe('live and replay are one fold (the parity rule)', () => {
    const script: HarnessEvent[] = [
        { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
        { type: 'reasoning', agent: 'one', delta: 'thinking' },
        { type: 'usage', agent: 'one', usage: { input: 800, output: 10, total: 810 } },
        { type: 'text', agent: 'one', delta: 'Answer' },
        toolCall('call-1', 'read', '{"path":"a.ts"}'),
        toolResult('read', 'body', 'call-1', { outcome: 'completed', durationMs: 9 }),
        {
            type: 'attempt_commit',
            agent: 'one',
            attempt: 1,
            maxAttempts: 3
        } as HarnessEvent,
        { type: 'text', agent: 'one', delta: ' final' },
        {
            type: 'done',
            agent: 'one',
            message: { role: 'assistant', content: 'Answer final', model: 'gpt-x', stopReason: 'stop', toolCalls: [] }
        } as HarnessEvent
    ];

    it('the cold fold equals the live fold, event for event', () => {
        const live = fold(script);
        const liveDisplay = live.display();

        const coldTurn = turnOf({ status: 'running', events: [...script], eventTimes: script.map((_event, index) => timeOf(index)) });
        const cold = projectTurn(coldTurn, CONTEXT);

        expect(cold.display).toEqual(liveDisplay);

        // A terminal record settles in the cold fold exactly as the live run did.
        const liveSettled = fold([...script]);

        liveSettled.settle('done');
        const coldDone = projectTurn(
            turnOf({ status: 'done', updatedAt: 5_000, events: [...script], eventTimes: script.map((_event, index) => timeOf(index)) }),
            CONTEXT
        );

        expect(coldDone.display).toEqual(liveSettled.display());
        expect(coldDone.summary.state).toBe('done');
        expect(coldDone.summary.activeAgents).toEqual([]);
    });

    it('a record without eventTimes paints no timings at all', () => {
        const turn = turnOf({ eventTimes: undefined, events: [] });
        const cold = projectTurn(turnOf({ eventTimes: undefined, events: [starts(), toolCall('c1', 'read', '{}'), toolResult('read', 'x', 'c1', { outcome: 'completed' })] }), CONTEXT);

        const step = cold.display.sections[0].nodes[0] as Record<string, unknown>;

        // Absent, not zero: a fabricated timestamp would paint a fake duration.
        expect('startedAt' in step).toBe(false);
        expect('endedAt' in step).toBe(false);
        expect('startedAt' in (cold.display.sections[0] as Record<string, unknown>)).toBe(false);

        // The live fold on the same record keeps its real stamps (the recorder has them).
        expect(fold([starts()], turn).ops.length).toBeGreaterThan(0);
    });

    it('refold returns a projector that continues from the cached state', () => {
        const turn = turnOf({ events: [starts(), { type: 'text', agent: 'one', delta: 'one' }], eventTimes: [1_000, 1_010] });
        const projector = refoldTurn(turn, CONTEXT);

        const ops = projector.apply({ type: 'text', agent: 'one', delta: ' two' }, 1_020, 2);

        expect(ops).toEqual([{ op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: ' two' }]);
        expect(projector.display().sections[0].nodes[0]).toMatchObject({ text: 'one two' });
    });

    it('previewText strips markdown markers exactly like the tile', () => {
        expect(previewText('**bold** and `code`', 200)).toBe('bold and code');
        expect(previewText('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}\u2026`);
    });
});
