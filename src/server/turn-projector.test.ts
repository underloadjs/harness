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
import { DISPLAY_ARGS_PREVIEW_CHARS, DISPLAY_PANELS_PER_STEP, DISPLAY_PREVIEW_CHARS, DISPLAY_TAIL_PAYLOAD_CHARS } from '../shared/turn-display';
import type {
    DisplayProjectContext,
    TurnDisplayOp,
    TurnInstructionSource,
    TurnRecordStatus,
    TurnSection
} from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, formatDuration, previewText, projectTurn, refoldTurn, steerSubmitList } from './turn-projector';

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
                    // The bar is always present: `[]` is the server's authoritative
                    // "nothing yet", and the prompt segment joins in the SAME frame.
                    context: [],
                    state: 'open'
                }
            },
            {
                op: 'context:add',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                block: {
                    kind: 'user',
                    id: '0-user-prompt',
                    turnId: 'turn-1',
                    sectionId: 'turn-1:0',
                    name: 'prompt',
                    at: 1_000,
                    // Exact `prompt.length` — no system source is recorded for this turn,
                    // so there is NO system segment (never a fabricated one).
                    chars: 12,
                    inPrompt: true
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
            {
                op: 'node:insert',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                node: { kind: 'text', id: 'n1', text: '', committed: false, chars: 0 }
            },
            {
                op: 'context:add',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                block: {
                    kind: 'assistant',
                    id: '0-assistant-1',
                    turnId: 'turn-1',
                    sectionId: 'turn-1:0',
                    name: 'answer',
                    at: 1_010,
                    chars: 0,
                    inPrompt: true,
                    eventFrom: 1,
                    eventTo: 1
                }
            },
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: 'Hel' },
            // The segment's count moves with the prose: metadata only, no text.
            { op: 'context:set', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-1', patch: { chars: 3 } },
            // R23: the prose just opened IS this section's newest block, so the fold names
            // it as the ONE body to display — the designation rides the same frame, after
            // the ops that established the node.
            {
                op: 'tail:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                tail: { kind: 'assistant', nodeId: 'n1', blockId: '0-assistant-1', chars: 3, truncated: false }
            }
        ]);
        expect(result.ops[2]).toEqual([
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: 'lo' },
            // The second delta came from a DIFFERENT recorded event, so the segment
            // moves its window end AND reports the span the two events bracket. The
            // designation does NOT re-publish: the block on screen did not change, only
            // its running count moved, and that figure already rode the segment above.
            {
                op: 'context:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                blockId: '0-assistant-1',
                patch: { chars: 5, durationMs: 10, eventTo: 2 }
            }
        ]);

        // Commit order: mark the nodes committed, move the copy pointer, close the window.
        const [committed, answer, boundary] = result.ops[3] as TurnDisplayOp[];

        expect(committed).toEqual({ op: 'node:set', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', patch: { committed: true } });
        expect(answer).toEqual({ op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:0', patch: { answerNodeId: 'n1' } });
        expect(boundary).toEqual({ op: 'attempt:commit', turnId: 'turn-1', sectionId: 'turn-1:0' });

        // The CURRENT answer keeps its full text (it is the designated carrier), and its
        // exact length rides beside it. `done` added no second segment: the deltas
        // already counted those bytes.
        expect(result.display().sections[0].nodes).toEqual([{ kind: 'text', id: 'n1', text: 'Hello', committed: true, chars: 5 }]);
        expect(result.display().sections[0].context?.map((block) => [block.id, block.chars])).toEqual([
            ['0-user-prompt', 12],
            ['0-assistant-1', 5]
        ]);
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
            section: { id: 'turn-1:1', role: 'subagent', agent: 'two', agentLabel: '', nodes: [], context: [], state: 'open' }
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

        // The STEP is still a summary, so a RAIL or a re-issued `step:set` never carries a
        // megabyte: the full bytes appear exactly once, on the ONE designated tail block,
        // each field bounded by `DISPLAY_TAIL_PAYLOAD_CHARS` with `truncated: true` saying
        // the record holds more (and the lazy step/block routes still answer in full).
        const tail = result.display().sections[0].tail as NonNullable<TurnSection['tail']>;

        expect(tail).toEqual({
            kind: 'tool',
            nodeId: '1',
            blockId: '0-tool-1',
            chars: huge.length * 2,
            truncated: true,
            args: huge.slice(0, DISPLAY_TAIL_PAYLOAD_CHARS),
            result: huge.slice(0, DISPLAY_TAIL_PAYLOAD_CHARS)
        });
        expect(JSON.stringify(result.display())).toContain('SENTINEL');
        expect(JSON.stringify(result.display()).length).toBeLessThan(DISPLAY_TAIL_PAYLOAD_CHARS * 5);
        // The compact ROW — what the rail and every list read — still holds no payload.
        expect(JSON.stringify(result.summary())).not.toContain('SENTINEL');
    });

    it('drops the current call payload from the tree the moment a newer block supersedes it', () => {
        // The marker sits in the MIDDLE of a payload far longer than the step's own preview,
        // so "the compiled view no longer holds it" is a real assertion — a head-truncated
        // `preview`/`argsPreview` can never reach it.
        const marker = 'MIDDLE-OF-THE-PAYLOAD-9f3c';
        const args = `{"tasks":[{"text":"${'filler-'.repeat(80)}${marker}${'-tail'.repeat(80)}"}]}`;
        const body = `${'body-'.repeat(120)}${marker}${'-end'.repeat(120)}`;
        const result = fold([
            starts(),
            toolCall('call-1', 'task', args),
            toolResult('task', body, 'call-1', { outcome: 'completed' }),
            { type: 'text', agent: 'one', delta: 'the answer' }
        ]);

        const display = result.display();

        expect(display.sections[0].tail).toEqual({
            kind: 'assistant',
            nodeId: 'n3',
            blockId: '0-assistant-3',
            // The designation-time figure; the segment carries the running exact count.
            chars: 10,
            truncated: false
        });
        // No payload field anywhere on the superseded call, and the megabyte is gone from
        // the whole compiled document.
        expect(display.sections[0].nodes[0]).not.toHaveProperty('args');
        expect(display.sections[0].nodes[0]).not.toHaveProperty('result');
        expect(JSON.stringify(display)).not.toContain(marker);
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
    // T16 (R16a): the line this test used to pin (`attempt 1 of 3 failed · retrying in
    // 1.5s · upstream 503`) is no longer minted. The DISCARD it shared a frame with is
    // the part that carries information, and it is asserted here op-for-op.
    it('removes the abandoned nodes and placeholders and mints no notice of its own', () => {
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

        // T16 (R16a): this frame's ops are the DISCARD and nothing else. It used to end
        // with a `node:insert` of a `retry`-tone notice, which the board printed once per
        // attempt; the server retries the same request internally, so the reader only
        // needs the abandoned output to disappear.
        //
        // A step node's id is its event index (the detail key), a prose node's is `n`
        // prefixed — the discard names exactly what this attempt created (its prose `n3`
        // and its call `4`), the delegation placeholder's whole section goes with it, and
        // nothing the EARLIER attempt committed is touched.
        expect(result.ops[5]).toEqual([
            { op: 'section:remove', turnId: 'turn-1', sectionId: 'turn-1:1' },
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-3' },
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-tool-4' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n3', '4'] },
            // R23: the discarded attempt held the tail, so the block BEFORE it becomes the
            // section's displayed body again — named by id, with its own segment beside it.
            // No `node:set` accompanies it here because a 14-character window never needed
            // bounding in the first place.
            {
                op: 'tail:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                tail: { kind: 'assistant', nodeId: 'n1', blockId: '0-assistant-1', chars: 14, truncated: false }
            }
        ]);

        // The committed turn survives; only the failed attempt's prose is gone, and the
        // ONLY nodes left are the committed prose — no notice line.
        expect(result.display().sections[0].nodes.map((node) => [node.kind, (node as { text?: string }).text])).toEqual([
            ['text', 'committed half']
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

// ---------------------------------------------------------------------------
// T16 (R16a): a transient retry is server-internal work, not a user-facing line.
//
// The board used to print one `attempt N of M failed · retrying in Xs · <error>` notice
// per attempt (the projector minted it). Eleven attempts meant eleven lines that read as
// failures while the agent was simply re-sending the SAME request. The compiled surface
// now carries NO retry text at all, live or on reload, and keeps exactly two behaviours:
//   - the failed attempt's PARTIAL output is still discarded (the mechanism), and
//   - the EXHAUSTED case is still a terminal error line (the outcome).
// The attempt/backoff/error evidence itself is untouched: it stays in `turn.events`,
// which the raw journal, `GET /sessions/:id/events` and the CLI (./cli/render.ts:193)
// still report.
// ---------------------------------------------------------------------------

// Two abandoned attempts of one request, the attempt that answers, and the terminal
// `error` frame whose message is the LAST attempt's own (../core/agent.ts:640).
const retrySequence = (): HarnessEvent[] => [
    { type: 'start', agent: 'one', model: 'gpt-x' },
    { type: 'text', agent: 'one', delta: 'partial one' },
    { type: 'retry', agent: 'one', attempt: 1, maxAttempts: 11, delayMs: 1_000, error: { message: 'Request failed: HTTP 500' } } as HarnessEvent,
    { type: 'text', agent: 'one', delta: 'partial two' },
    { type: 'retry', agent: 'one', attempt: 2, maxAttempts: 11, delayMs: 2_000, error: { message: 'Request failed: HTTP 502' } } as HarnessEvent,
    { type: 'text', agent: 'one', delta: 'the answer' },
    { type: 'attempt_commit', agent: 'one', attempt: 3, maxAttempts: 11 } as HarnessEvent,
    { type: 'error', agent: 'one', error: { message: 'Request failed: HTTP 503' } } as HarnessEvent
];

const timesOf = (events: HarnessEvent[]): number[] => events.map((_event, index) => timeOf(index));

// Every notice node the compiled surface holds, in section order.
const noticesOf = (display: ReturnType<typeof projectTurn>['display']): unknown[] =>
    display.sections.flatMap((section) => section.nodes).filter((node) => node.kind === 'notice');

describe('transient retries leave no user-facing line (T16, R16a)', () => {
    it('sends no notice for a retry, live, while the attempt output still goes', () => {
        // Everything up to and including the SECOND failed attempt: the run is mid-backoff.
        const result = fold(retrySequence().slice(0, 5));

        // One retry frame = its segment + its nodes, and the tail it took with them. No
        // `node:insert`, so nothing for the board to print and no notice for a `node:remove`
        // to later clean up; `tail:clear` is the server stating that this section now has no
        // block to display, which is not the same statement as a silent producer (R23).
        expect(result.ops[2]).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-1' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n1'] },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:0' }
        ]);
        expect(result.ops[4]).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-3' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n3'] },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:0' }
        ]);

        // Nothing retry-shaped exists anywhere in the tree the browser draws.
        expect(noticesOf(result.display())).toEqual([]);
    });

    it('keeps the turn streaming through the backoff, so the status never reads as idle', () => {
        const result = fold(retrySequence().slice(0, 5));

        // The server's own figures: the row is still `running`/`streaming` and the agent
        // is still active, because a `retry` changes no section state. The tile derives
        // its status from `TurnSection.state` (../frontend/ui/turns.ts:5376) and the
        // activity ring from these ops (../frontend/view-state.ts:820), so dropping the
        // notice line drops no status signal with it.
        expect(result.display().sections.map((section) => [section.id, section.state])).toEqual([['turn-1:0', 'streaming']]);
        expect(result.summary()).toMatchObject({
            status: 'running',
            state: 'streaming',
            stepCount: 0,
            activeAgents: ['one']
        });
    });

    it('keeps the terminal failure of an exhausted sequence, live and on reload', () => {
        const sequence = retrySequence();
        const live = fold(sequence);

        live.settle('error');

        // ONE notice for the whole 11-attempt sequence, and it is the terminal error,
        // verbatim from the `error` frame — not one of the per-attempt messages.
        expect(noticesOf(live.display())).toEqual([
            { kind: 'notice', id: 'n7', tone: 'error', text: 'Request failed: HTTP 503', at: 1_070 }
        ]);
        expect(live.summary()).toMatchObject({ status: 'error', state: 'error', detail: 'Request failed: HTTP 503' });

        // The cold fold (what a reload answers) is the SAME tree: the retry omission is
        // not a live-only filter, it is one code path.
        const cold = projectTurn(turnOf({ status: 'error', updatedAt: 5_000, events: [...sequence], eventTimes: timesOf(sequence) }), CONTEXT);

        expect(cold.display).toEqual(live.display());
        expect(cold.summary).toMatchObject({ status: 'error', state: 'error', detail: 'Request failed: HTTP 503' });

        // And the word is gone from the whole compiled document, in both directions.
        expect(JSON.stringify(cold.display)).not.toContain('retry');
        expect(JSON.stringify(live.display())).not.toContain('retry');
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

        // T16 (R16a): the retry frame now leaves the question ALONE — it mints no notice
        // either, so the surviving array is the action itself and nothing else.
        expect(discarded.display().sections[0].nodes.map((node) => node.kind)).toEqual(['action']);
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

        // The cached state continues: the prose appends (3 + 4 = 7 characters), and the
        // segment minted during the replay moves to the new exact length, reports the
        // span the two events bracket, and advances its window end.
        expect(ops).toEqual([
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: ' two' },
            {
                op: 'context:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                blockId: '0-assistant-1',
                patch: { chars: 7, durationMs: 10, eventTo: 2 }
            }
        ]);
        expect(projector.display().sections[0].nodes[0]).toMatchObject({ text: 'one two' });
    });

    it('previewText strips markdown markers exactly like the tile', () => {
        expect(previewText('**bold** and `code`', 200)).toBe('bold and code');
        expect(previewText('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}\u2026`);
    });
});

// ---------------------------------------------------------------------------
// The context bar (T10, R6/R8): one metadata segment per recorded source, with
// EXACT character counts, and nothing else on the default wire.
// ---------------------------------------------------------------------------

// Durable evidence the fold is handed (./sessions.ts `noteInstructionSource` writes
// this map; the fold only ever READS it). 'one' has two entries (8 + 8 characters),
// 'two' has an EMPTY list, which is evidence of "no system message" — not absence.
const SOURCES: TurnInstructionSource[] = [
    { agent: 'one', instructions: ['inst-one', 'inst-two'], at: 900 },
    { agent: 'two', instructions: [], at: 900 }
];

const SOURCED: DisplayProjectContext = { primary: 'one', instructionSourcesOf: () => SOURCES };

const EMPTY_SOURCE: DisplayProjectContext = {
    primary: 'one',
    instructionSourcesOf: () => [{ agent: 'one', instructions: [], at: 900 }]
};

describe('context bar (R6/R8)', () => {
    it('mints one segment per recorded source, with exact counts and no text', () => {
        const result = fold(
            [
                starts(),
                { type: 'reasoning', agent: 'one', delta: 'think ' },
                { type: 'reasoning', agent: 'one', delta: 'on it' },
                toolCall('call-1', 'read', '{"path":"a"}'),
                toolResult('read', 'hello', 'call-1', { outcome: 'completed', durationMs: 25 }),
                { type: 'text', agent: 'one', delta: 'Answer' },
                {
                    type: 'done',
                    agent: 'one',
                    message: { role: 'assistant', content: 'Answer', model: 'gpt-x', stopReason: 'stop', toolCalls: [] }
                } as HarnessEvent
            ],
            turnOf(),
            SOURCED
        );

        // Exact, whole, in bar order: system first (it heads every request), then the
        // prompt, then the flow in recorded time order.
        expect(result.display().sections[0].context).toEqual([
            {
                kind: 'system',
                id: '0-system-instructions',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'instructions',
                at: 900,
                chars: 16,
                inPrompt: true
            },
            {
                kind: 'user',
                id: '0-user-prompt',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'prompt',
                at: 1_000,
                chars: 12,
                inPrompt: true
            },
            {
                kind: 'reasoning',
                id: '0-reasoning-1',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'reasoning',
                at: 1_010,
                // 6 + 5 recorded delta characters — the exact bytes, while the node's
                // own wire text may be shorter.
                chars: 11,
                durationMs: 10,
                inPrompt: false,
                eventFrom: 1,
                eventTo: 2
            },
            {
                kind: 'tool',
                id: '0-tool-3',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'read',
                at: 1_030,
                endedAt: 1_040,
                chars: 17,
                argsChars: 12,
                resultChars: 5,
                durationMs: 25,
                inPrompt: true,
                state: 'ok',
                eventFrom: 3,
                eventTo: 4
            },
            {
                kind: 'assistant',
                id: '0-assistant-5',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'answer',
                at: 1_050,
                chars: 6,
                inPrompt: true,
                eventFrom: 5,
                eventTo: 5
            }
        ]);

        // The `done` frame repeats the response text; it must not count it twice.
        expect(result.display().sections[0].context?.filter((block) => block.kind === 'assistant')).toHaveLength(1);
        // And a segment carries NO text, so the frame stays bounded however long the
        // conversation is.
        for (const block of result.display().sections[0].context ?? []) {
            expect(Object.keys(block)).not.toContain('text');
            expect(Object.keys(block)).not.toContain('preview');
        }
    });

    it('reports the instruction count for a section and none at all without evidence', () => {
        // Every section of an agent with a recorded source carries exactly ONE system
        // segment — the delegated child ('two', an empty list) reports zero characters
        // rather than inventing a catalogue sentence.
        const childThread = { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', kind: 'delegation' as const };
        const result = fold(
            [
                { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
                toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two', input: 'sub task' })),
                { type: 'start', agent: 'two', model: 'gpt-y', thread: childThread }
            ],
            turnOf({ threadId: 'th-1', threadLabel: 'RR1' }),
            SOURCED
        );

        expect(result.display().sections[0].context?.[0]).toEqual({
            kind: 'system',
            id: '0-system-instructions',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'instructions',
            at: 900,
            chars: 16,
            inPrompt: true
        });
        expect(result.display().sections[1].context).toEqual([
            {
                kind: 'system',
                id: '1-system-instructions',
                turnId: 'turn-1',
                sectionId: 'turn-1:1',
                name: 'instructions',
                at: 900,
                // An EMPTY instruction list is recorded evidence: zero, not absent.
                chars: 0,
                inPrompt: true
            }
        ]);

        // No resolver at all (a legacy document): NO system segment, honestly.
        const legacy = fold([starts()]);

        expect(legacy.display().sections[0].context?.map((block) => block.kind)).toEqual(['user']);

        // An agent the record never mentions gets nothing either (the event must be a
        // real `start` frame — the fold ignores anything else).
        const unknown = fold([{ type: 'start', agent: 'three', model: 'gpt-z' }], turnOf(), EMPTY_SOURCE);

        expect(unknown.display().sections[0].context).toEqual([]);
    });

    it('streams a think window IN FULL while it holds the tail, then bounds it when the answer takes the tail', () => {
        const long = fold([
            starts(),
            { type: 'reasoning', agent: 'one', delta: 'a'.repeat(200) },
            { type: 'reasoning', agent: 'one', delta: 'b'.repeat(200) },
            { type: 'reasoning', agent: 'one', delta: 'c'.repeat(200) },
            { type: 'text', agent: 'one', delta: 'x'.repeat(400) }
        ]);

        const nodes = long.display().sections[0].nodes as Record<string, unknown>[];

        // R23 (T23): the thinking window WAS the section's displayed body, so every delta
        // travelled whole; the answer is the newest block now, so the wire copy is the
        // 320-character preview and the EXACT 600 lives on the segment (and on the lazy
        // detail route). A historical window is never replayed in full.
        expect(nodes[0]).toEqual({
            kind: 'reasoning',
            id: 'n1',
            text: `${'a'.repeat(200)}${'b'.repeat(119)}\u2026`,
            chars: 600,
            redacted: true
        });
        // The designated tail is the other half of the same rule: 400 characters of prose
        // travel whole, because it is the block on screen.
        expect(nodes[1]).toEqual({ kind: 'text', id: 'n4', text: 'x'.repeat(400), committed: false, chars: 400 });
        expect(long.display().sections[0].tail).toEqual({
            kind: 'assistant',
            nodeId: 'n4',
            blockId: '0-assistant-4',
            chars: 400,
            truncated: false
        });

        expect(long.display().sections[0].context?.map((block) => [block.id, block.chars])).toEqual([
            ['0-user-prompt', 12],
            ['0-reasoning-1', 600],
            ['0-assistant-4', 400]
        ]);

        // The op stream agrees with the reloaded view: every delta appended whole, and ONE
        // redaction patch at the frame the answer supersedes it — never a per-token resend.
        expect(long.ops[2]).toEqual([
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: 'b'.repeat(200) },
            {
                op: 'context:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                blockId: '0-reasoning-1',
                patch: { chars: 400, durationMs: 10, eventTo: 2 }
            }
        ]);
        expect(long.ops[3]).toEqual([
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: 'c'.repeat(200) },
            {
                op: 'context:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                blockId: '0-reasoning-1',
                patch: { chars: 600, durationMs: 20, eventTo: 3 }
            }
        ]);
        // The one frame that moves the tail: the new window's bytes, the old window's
        // preview, and the designation — in that order, so a client never holds a
        // designation naming a node it has not received.
        expect(long.ops[4]).toEqual([
            {
                op: 'node:insert',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                node: { kind: 'text', id: 'n4', text: '', committed: false, chars: 0 }
            },
            {
                op: 'context:add',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                block: expect.objectContaining({ id: '0-assistant-4', kind: 'assistant', chars: 0 })
            },
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n4', delta: 'x'.repeat(400) },
            {
                op: 'context:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                blockId: '0-assistant-4',
                // One event so far: the running count moves, and there is no span to report
                // and no window end to extend (`flowWindowPatch` needs two distinct events).
                patch: { chars: 400 }
            },
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: `${'a'.repeat(200)}${'b'.repeat(119)}\u2026`, chars: 600, redacted: true }
            },
            {
                op: 'tail:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                tail: { kind: 'assistant', nodeId: 'n4', blockId: '0-assistant-4', chars: 400, truncated: false }
            }
        ]);
    });

    it('redacts a superseded answer by op, exactly as the reloaded view shows it', () => {
        const result = fold([
            starts(),
            { type: 'text', agent: 'one', delta: 'a'.repeat(400) },
            toolCall('call-1', 'read', '{}'),
            toolResult('read', 'r', 'call-1', { outcome: 'completed' }),
            { type: 'text', agent: 'one', delta: 'b'.repeat(400) },
            { type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 2 } as HarnessEvent
        ]);

        // A prose window closed by a tool call is no longer the section's newest block, so
        // it is bounded in THAT frame — one patch, exact length, and the marker the client
        // needs (no length comparison to infer it). The order within the frame is the
        // contract: the new block's own ops first, then the body it superseded, then the
        // designation, so a client never holds a tail naming a node it has not received.
        expect(result.ops[2]).toEqual([
            { op: 'step:set', turnId: 'turn-1', sectionId: 'turn-1:0', step: expect.objectContaining({ id: '2', name: 'read' }) },
            {
                op: 'context:add',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                block: expect.objectContaining({ id: '0-tool-2', kind: 'tool', chars: 2, argsChars: 2, state: 'running' })
            },
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: `${'a'.repeat(319)}\u2026`, chars: 400, redacted: true }
            },
            {
                op: 'tail:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                tail: { kind: 'tool', nodeId: '2', blockId: '0-tool-2', chars: 2, truncated: false, args: '{}' }
            }
        ]);

        // The commit moves the answer pointer and does NOT redact twice.
        expect(result.ops[5].filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([
            { op: 'node:set', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', patch: { committed: true } }
        ]);

        const nodes = result.display().sections[0].nodes as Record<string, unknown>[];

        // Reload view == the stream: the historical answer arrives bounded with its
        // exact length, and the newest one is still whole.
        expect(nodes[0]).toEqual({
            kind: 'text',
            id: 'n1',
            text: `${'a'.repeat(319)}\u2026`,
            committed: true,
            chars: 400,
            redacted: true
        });
        expect(nodes[2]).toEqual({ kind: 'text', id: 'n4', text: 'b'.repeat(400), committed: true, chars: 400 });
        expect(result.display().sections[0].context?.map((block) => [block.id, block.chars])).toEqual([
            ['0-user-prompt', 12],
            ['0-assistant-1', 400],
            ['0-tool-2', 3],
            ['0-assistant-4', 400]
        ]);
    });

    it('removes exactly the discarded attempt segments on a retry', () => {
        const result = fold(
            [
                starts(),
                { type: 'reasoning', agent: 'one', delta: 'thought' },
                { type: 'text', agent: 'one', delta: 'partial' },
                toolCall('call-1', 'read', '{}'),
                {
                    type: 'retry',
                    agent: 'one',
                    attempt: 1,
                    maxAttempts: 2,
                    delayMs: 0,
                    error: { message: 'boom' }
                } as HarnessEvent,
                { type: 'reasoning', agent: 'one', delta: 'better' }
            ],
            turnOf(),
            SOURCED
        );

        // The attempt's three segments go, by id; the turn's own prompt and instruction
        // segments stay (they were never attempt output).
        expect(result.ops[4].filter((op) => op.op === 'context:remove').map((op) => (op as { blockId: string }).blockId)).toEqual([
            '0-reasoning-1',
            '0-assistant-2',
            '0-tool-3'
        ]);

        const kept = result.display().sections[0].context ?? [];

        expect(kept.map((block) => [block.id, block.chars])).toEqual([
            ['0-system-instructions', 16],
            ['0-user-prompt', 12],
            ['0-reasoning-5', 6]
        ]);
        // A retry is neither conversation text nor a segment: it adds no `user` block, and
        // since T16 (R16a) it mints no notice either.
        expect(kept.filter((block) => block.kind === 'user')).toHaveLength(1);
    });

    it('settles a segment an abandoned call leaves behind: args only, no invented duration', () => {
        const result = fold([starts(), toolCall('call-1', 'read', '{"q":1}')]);

        result.settle('error');

        // Default CONTEXT: no instruction evidence, so the bar is the prompt segment
        // and this call — index 1 is the segment under test.
        expect(result.display().sections[0].context?.[1]).toEqual({
            kind: 'tool',
            id: '0-tool-1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'read',
            at: 1_010,
            endedAt: 5_000,
            chars: 7,
            argsChars: 7,
            inPrompt: true,
            state: 'error',
            eventFrom: 1,
            eventTo: 1
        });
    });

    it('places a steered submit by recorded time and keys it position-independently', () => {
        const turn = turnOf({ steers: [{ at: 1_005, prompt: 'go' }] });
        const result = fold(
            [starts(), { type: 'reasoning', agent: 'one', delta: 'x' }],
            turn,
            SOURCED
        );

        // The submit is adopted on the first event whose stamp reaches it (the start at
        // 1000 does not; the reasoning delta at 1010 does), and it sorts BETWEEN the
        // prompt and the later flow segment by its recorded time.
        expect(result.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-s1005-2',
            '0-reasoning-1'
        ]);
        expect(result.display().sections[0].context?.[2]).toEqual({
            kind: 'user',
            id: '0-user-s1005-2',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'steer',
            at: 1_005,
            chars: 2,
            inPrompt: true
        });

        // The steer list is a bounded ring, so the key is built from the submit itself.
        // Truncating an OLDER submit therefore cannot renumber a surviving one, and a
        // submit recorded after the LAST stored event joins when the turn settles —
        // exactly when a live run would have adopted it too.
        const laterTurn = turnOf({ steers: [{ at: 1_005, prompt: 'go' }, { at: 1_012, prompt: 'keep me' }] });
        const later = fold([starts(), { type: 'text', agent: 'one', delta: 'y' }], laterTurn, SOURCED);

        expect(later.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-s1005-2',
            '0-assistant-1'
        ]);

        later.settle('done');

        expect(later.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-s1005-2',
            '0-assistant-1',
            '0-user-s1012-7'
        ]);
    });

    it('numbers two submits recorded in one millisecond apart, so neither loses its segment', () => {
        // The record cannot tell the first two apart: same `at`, same text length. The
        // second is numbered `-1` (./turn-projector.ts `steerBlockKeysOf`), so R6's "every
        // recorded submit, exactly once" survives a same-millisecond pair, and a submit of
        // a DIFFERENT length is never numbered.
        //
        // These fixtures carry NO `SessionSteerRecord.id` on purpose: that is the legacy
        // document shape, and the derived numbering is its compatibility path. A record with
        // ids takes the identity path below, which needs no numbering at all.
        const turn = turnOf({
            steers: [
                { at: 1_005, prompt: 'aaaa' },
                { at: 1_005, prompt: 'bbbb' },
                { at: 1_005, prompt: 'ccccc' }
            ]
        });
        const result = fold([starts(), { type: 'reasoning', agent: 'one', delta: 'x' }], turn, SOURCED);
        const segments = result.display().sections[0].context ?? [];

        expect(segments.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-s1005-4',
            '0-user-s1005-4-1',
            '0-user-s1005-5',
            '0-reasoning-1'
        ]);

        // Each segment counts its OWN submit: no merge, no shared count.
        expect(segments.filter((block) => block.name === 'steer')).toEqual([
            {
                kind: 'user',
                id: '0-user-s1005-4',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'steer',
                at: 1_005,
                chars: 4,
                inPrompt: true
            },
            {
                kind: 'user',
                id: '0-user-s1005-4-1',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'steer',
                at: 1_005,
                chars: 4,
                inPrompt: true
            },
            {
                kind: 'user',
                id: '0-user-s1005-5',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'steer',
                at: 1_005,
                chars: 5,
                inPrompt: true
            }
        ]);

        // The ops the live stream sent name the same two ids, in the same order — a client
        // applying them lands on the bar a reload receives.
        const added = flatten(result.ops)
            .filter((op) => op.op === 'context:add')
            .map((op) => (op as { block: { id: string } }).block.id);

        expect(added).toEqual(['0-system-instructions', '0-user-prompt', '0-user-s1005-4', '0-user-s1005-4-1', '0-user-s1005-5', '0-reasoning-1']);
    });

    it('keys a steered segment by the submit\u2019s own recorded identity, and never renumbers one', () => {
        // T13: a record that carries `SessionSteerRecord.id` is keyed by THAT identity, so
        // three submits that ALL derive the same `(at, length)` pair still own three distinct
        // segments, and no ordering or truncation rule can move one.
        const turn = turnOf({
            steers: [
                { id: 'steer-a', at: 1_005, prompt: 'aaaa' },
                { id: 'steer-b', at: 1_005, prompt: 'bbbb' },
                { id: 'steer-c', at: 1_005, prompt: 'cccc' }
            ]
        });
        const result = fold([starts(), { type: 'reasoning', agent: 'one', delta: 'x' }], turn, SOURCED);

        expect(result.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-isteer-a',
            '0-user-isteer-b',
            '0-user-isteer-c',
            '0-reasoning-1'
        ]);

        // The segment metadata is per submit: its own length, its own recorded time.
        expect(
            result
                .display()
                .sections[0]
                .context?.filter((block) => block.name === 'steer')
                .map((block) => [block.id, block.chars, block.at, block.inPrompt])
        ).toEqual([
            ['0-user-isteer-a', 4, 1_005, true],
            ['0-user-isteer-b', 4, 1_005, true],
            ['0-user-isteer-c', 4, 1_005, true]
        ]);

        // The ROW carries the same identity, so a client addresses a submit by the id the
        // server minted rather than by a timestamp it would have to match.
        expect(result.summary().steers).toEqual([
            { id: 'steer-a', at: 1_005, prompt: 'aaaa' },
            { id: 'steer-b', at: 1_005, prompt: 'bbbb' },
            { id: 'steer-c', at: 1_005, prompt: 'cccc' }
        ]);

        // Trimming the bounded ring drops the OLDEST entries and cannot touch a survivor: the
        // keys of the submits that remain are exactly the keys they had before.
        const trimmed = fold(
            [starts(), { type: 'reasoning', agent: 'one', delta: 'x' }],
            turnOf({ steers: [{ id: 'steer-b', at: 1_005, prompt: 'bbbb' }, { id: 'steer-c', at: 1_005, prompt: 'cccc' }] }),
            SOURCED
        );

        expect(trimmed.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-isteer-b',
            '0-user-isteer-c',
            '0-reasoning-1'
        ]);

        // A MIXED document (an upgraded server appending idented submits to a legacy turn)
        // keeps both rules side by side: identity for the idented submit, deterministic
        // numbering for the keyless pair.
        const mixed = fold(
            [starts(), { type: 'reasoning', agent: 'one', delta: 'x' }],
            turnOf({
                steers: [
                    { at: 1_005, prompt: 'aaaa' },
                    { id: 'steer-a', at: 1_005, prompt: 'bbbb' },
                    { at: 1_005, prompt: 'cccc' }
                ]
            }),
            SOURCED
        );

        expect(mixed.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-s1005-4',
            '0-user-isteer-a',
            '0-user-s1005-4-1',
            '0-reasoning-1'
        ]);
    });

    it('draws every ARCHIVED submit, not only the ones the audit ring kept', () => {
        // T14: `steers` is the bounded OPERATIONAL audit ring and `steerTexts` is the durable
        // TEXT archive — every submit the server accepted, keyed by its own id. The bar is
        // minted from the MERGED list, so a submit the ring has already truncated keeps its
        // segment and still answers a click (R8), while the compact row keeps its bounded
        // audit ring (no archived text on the default wire).
        const archive = Array.from({ length: 5 }, (_, index) => ({
            id: `st-${index}`,
            at: 1_005 + index,
            prompt: `p${index}`
        }));
        // The ring kept the LAST three; the first two are the trimmed ones under test.
        const ring = archive.slice(2);
        const merged = fold(
            [starts(), { type: 'reasoning', agent: 'one', delta: 'x' }],
            turnOf({ steers: ring, steerTexts: archive }),
            SOURCED
        );

        // One segment per ARCHIVED submit, in acceptance order: the ring's trimming cannot
        // remove a submit the bar already drew (or will draw).
        expect(merged.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-ist-0',
            '0-user-ist-1',
            '0-user-ist-2',
            '0-user-ist-3',
            '0-user-ist-4',
            '0-reasoning-1'
        ]);

        // R6: each counts its OWN text exactly once, with its own recorded time.
        expect(
            merged
                .display()
                .sections[0]
                .context?.filter((block) => block.name === 'steer')
                .map((block) => [block.id, block.chars, block.at, block.inPrompt])
        ).toEqual([
            ['0-user-ist-0', 2, 1_005, true],
            ['0-user-ist-1', 2, 1_006, true],
            ['0-user-ist-2', 2, 1_007, true],
            ['0-user-ist-3', 2, 1_008, true],
            ['0-user-ist-4', 2, 1_009, true]
        ]);

        // The row keeps the 64-entry AUDIT semantics: exactly the ring, with its own text,
        // and the two archived-only prompts never reach the wire.
        expect(merged.summary().steers).toEqual([
            { id: 'st-2', at: 1_007, prompt: 'p2' },
            { id: 'st-3', at: 1_008, prompt: 'p3' },
            { id: 'st-4', at: 1_009, prompt: 'p4' }
        ]);
        expect(JSON.stringify(merged.summary())).not.toContain('"p0"');
        expect(JSON.stringify(merged.summary())).not.toContain('"p1"');

        // A document whose ring has moved past EVERYTHING it archived still reproduces the
        // whole bar (the trimmed-ring restart case).
        const emptied = fold(
            [starts(), { type: 'reasoning', agent: 'one', delta: 'x' }],
            turnOf({ steers: [], steerTexts: archive }),
            SOURCED
        );

        expect(
            emptied.display().sections[0].context?.filter((block) => block.name === 'steer').map((block) => block.id)
        ).toEqual(['0-user-ist-0', '0-user-ist-1', '0-user-ist-2', '0-user-ist-3', '0-user-ist-4']);

        // The merge itself, pinned directly (./turn-projector.ts `steerSubmitList`): the two
        // arrays describe the same submits, so the shared ones appear ONCE, and a submit the
        // archive does not name is a PRE-archive record — older than everything archived, so
        // it keeps its recorded place at the FRONT.
        expect(steerSubmitList({ steers: ring, steerTexts: archive }).map((submit) => submit.id)).toEqual([
            'st-0',
            'st-1',
            'st-2',
            'st-3',
            'st-4'
        ]);
        expect(
            steerSubmitList({
                steers: [{ at: 1_005, prompt: 'old' }, { id: 'st-9', at: 1_006, prompt: 'new' }],
                steerTexts: [{ id: 'st-9', at: 1_006, prompt: 'new' }]
            }).map((submit) => [submit.id ?? 'keyless', submit.prompt])
        ).toEqual([
            ['keyless', 'old'],
            ['st-9', 'new']
        ]);
        // No archive (a legacy record) means the ring IS the complete list, unchanged.
        expect(steerSubmitList({ steers: [{ at: 1_005, prompt: 'solo' }] })).toEqual([{ at: 1_005, prompt: 'solo' }]);
        expect(steerSubmitList({})).toEqual([]);
    });

    it('adopts a steered submit through syncSteers, before the run records another event', () => {
        // T14: guidance is a RECORD mutation, not an event, so a fold that only runs on
        // `apply`/`settle` would leave the submit the user just typed off the bar until the
        // next model boundary. The store calls `syncSteers` (../shared/turn-display.ts
        // `TurnProjector`) with the submit's own stamp the moment it accepts it, and the ops
        // it returns go to live display watchers like any recorded event's do.
        const turn = turnOf({
            steers: [{ id: 'live-1', at: 1_005, prompt: 'now' }],
            steerTexts: [{ id: 'live-1', at: 1_005, prompt: 'now' }]
        });
        const projector = createTurnProjector(turn, SOURCED);

        // The `start` event is stamped BEFORE the submit was recorded, so the adoption gate
        // has not admitted it yet: no steer segment, and nothing to resolve.
        projector.apply(starts(), 1_002, 0);

        expect((projector.display().sections[0].context ?? []).map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt'
        ]);

        const ops = projector.syncSteers(1_005);
        const added = ops.filter((op) => op.op === 'context:add').map((op) => (op as { block: { id: string } }).block.id);

        expect(added).toEqual(['0-user-ilive-1']);
        expect(projector.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            '0-user-ilive-1'
        ]);

        // Idempotent: a repeat adoption (or a later event, which folds the whole list again)
        // mints the segment exactly once, so a live client never sees a doubled bar entry.
        expect(projector.syncSteers(1_006)).toEqual([]);

        turn.events.push({ type: 'text', agent: 'one', delta: 'answer' });
        turn.eventTimes?.push(1_006);

        // The later event re-folds the WHOLE submit list (that is how a cold replay works)
        // and still mints the steered segment exactly once, so a live client never gets a
        // doubled bar entry. The answer's own segment is new and does arrive.
        const later = projector
            .apply({ type: 'text', agent: 'one', delta: 'answer' }, 1_006, 1)
            .filter((op) => op.op === 'context:add')
            .map((op) => (op as { block: { id: string } }).block.id);

        expect(later.filter((id) => id.startsWith('0-user-i'))).toEqual([]);
        expect(later).toEqual(['0-assistant-1']);
        expect(projector.display().sections[0].context?.filter((block) => block.name === 'steer')).toHaveLength(1);
    });

    it('counts a response that streamed no deltas, and a result-only frame, without double counting', () => {
        // A reporter that answers without streaming: the `done` message IS the answer,
        // so it becomes the segment (and only then).
        const noDeltas = fold([
            starts(),
            {
                type: 'done',
                agent: 'one',
                message: { role: 'assistant', content: 'Whole answer', model: 'gpt-x', stopReason: 'stop', toolCalls: [] }
            } as HarnessEvent
        ]);

        expect(noDeltas.display().sections[0].context?.[1]).toEqual({
            kind: 'assistant',
            id: '0-assistant-1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'answer',
            at: 1_010,
            chars: 12,
            inPrompt: true,
            eventFrom: 1,
            eventTo: 1
        });

        // A result with no recorded call: the result text is all the record holds, so
        // `argsChars` stays ABSENT instead of claiming a zero that never happened.
        const resultOnly = fold([starts(), toolResult('read', 'abc', 'call-9', { outcome: 'completed' })]);

        expect(resultOnly.display().sections[0].context?.[1]).toEqual({
            kind: 'tool',
            id: '0-tool-1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'read',
            at: 1_010,
            endedAt: 1_010,
            chars: 3,
            resultChars: 3,
            inPrompt: true,
            state: 'ok',
            eventFrom: 1,
            eventTo: 1
        });
    });

    it('folds the same bar live and cold, with sources, a steer, and a settled tool', () => {
        const script: HarnessEvent[] = [
            starts(),
            { type: 'reasoning', agent: 'one', delta: 'hm' },
            { type: 'text', agent: 'one', delta: 'half' },
            toolCall('call-1', 'read', '{"p":1}'),
            toolResult('read', 'done body', 'call-1', { outcome: 'failed', durationMs: 41 }),
            {
                type: 'done',
                agent: 'one',
                message: { role: 'assistant', content: 'half', model: 'gpt-x', stopReason: 'stop', toolCalls: [] }
            } as HarnessEvent
        ];
        const steers = [{ at: 1_005, prompt: 'hurry' }];
        const liveTurn = turnOf({ steers });
        const live = fold(script, liveTurn, SOURCED);

        // The store's recorder bumps `updatedAt` with every stored event and again when
        // the turn settles; the fake recorder here does the same, so the ROW the live
        // path caches is comparable with the cold fold's.
        liveTurn.updatedAt = 5_000;
        live.settle('done');

        const coldRecord = turnOf({
            status: 'done',
            updatedAt: 5_000,
            steers,
            events: [...script],
            eventTimes: script.map((_event, index) => timeOf(index))
        });
        const cold = projectTurn(coldRecord, SOURCED);

        // The bar, the node text bounds and every count are ONE value in both paths —
        // a reload paints exactly what the stream painted.
        expect(cold.display).toEqual(live.display());
        expect(cold.summary).toEqual(live.summary());
        expect(cold.display.sections[0].context?.map((block) => [block.id, block.chars, block.state])).toEqual([
            ['0-system-instructions', 16, undefined],
            ['0-user-prompt', 12, undefined],
            ['0-user-s1005-5', 5, undefined],
            ['0-reasoning-1', 2, undefined],
            ['0-assistant-2', 4, undefined],
            // 7 recorded argument characters + 9 recorded result characters, and the
            // tool's own measured span. A FAILED result still counts: its text is
            // delivered to the model like any other.
            ['0-tool-3', 16, 'error']
        ]);
    });
});
