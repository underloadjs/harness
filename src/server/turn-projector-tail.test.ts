// T23: the ONE current tail block of every section (R23), proven on the server fold.
//
// What this file owns is the SERVER half of the rule the browser only reads:
//   - the newest eligible content block of each section is designated, in the section's own
//     recorded order, and it is designated by the SAME code path live and on replay
//     (../server/turn-projector.ts `resolveTail`/`syncTails`);
//   - "eligible" is reasoning, an answer, or a recorded CALL — a call while it runs with its
//     complete recorded arguments, and with its complete recorded response once it settles;
//   - `user`, `system`, a `notice` (wake / error / answered / the pending line) and an
//     `action` question are NOT eligible, so nothing that is not model content can erase the
//     block the reader is looking at;
//   - exactly one full body per section, root and delegate independent, and a superseded
//     payload is DROPPED from the compiled view in the frame that replaced it;
//   - the designation is re-sent when it moves, never once per token, and never for a block
//     that did not change.
//
// The op-level pins in ./turn-projector.test.ts cover the frames this rule touches; the
// tile that draws the body is covered in ../frontend/ui/turns-tail.test.ts and the
// projector->reducer->tile parity in ../frontend/ui/turns-tail-server.test.ts.
//
// Run: npx vitest run src/server/turn-projector-tail.test.ts

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import {
    DISPLAY_ARGS_PREVIEW_CHARS,
    DISPLAY_NODE_PREVIEW_CHARS,
    DISPLAY_PREVIEW_CHARS,
    DISPLAY_TAIL_PAYLOAD_CHARS
} from '../shared/turn-display';
import type { DisplayProjectContext, DisplayTail, TurnDisplay, TurnDisplayOp, TurnSection } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

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

// Recorded instruction evidence, so the bar mints a `system` segment for the root section
// and the "system is never the tail" claim is about a real segment, not an absent one.
const SOURCED: DisplayProjectContext = {
    primary: 'one',
    instructionSourcesOf: () => [{ agent: 'one', instructions: ['You are the one agent.'] }]
};

const timeOf = (index: number): number => 1_000 + index * 10;

type Folded = {
    ops: TurnDisplayOp[][];
    display: () => TurnDisplay;
    settle: (status: 'done' | 'error' | 'cancelled') => TurnDisplayOp[];
};

// The live path (the recorder's order: push the record, then fold it) — the one code path a
// reload also runs, which is what makes every parity claim below a checked claim.
const fold = (events: HarnessEvent[], turn: SessionTurn = turnOf(), context: DisplayProjectContext = SOURCED): Folded => {
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
        settle: (status) => projector.settle(status, 5_000)
    };
};

const starts = (turn: HarnessEvent = { type: 'start', agent: 'one', model: 'gpt-x' }): HarnessEvent => turn;

const think = (delta: string): HarnessEvent => ({ type: 'reasoning', agent: 'one', delta });

const say = (delta: string): HarnessEvent => ({ type: 'text', agent: 'one', delta });

const toolCall = (id: string, name: string, args: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id, name, arguments: args }
});

const toolResult = (
    name: string,
    content: string,
    callId: string,
    extra: Partial<Extract<HarnessEvent, { type: 'tool_result' }>> = {}
): HarnessEvent => ({
    type: 'tool_result',
    agent: 'one',
    name,
    content,
    isError: extra.isError ?? false,
    callId,
    ...extra
});

const tailOf = (display: TurnDisplay, sectionPosition = 0): DisplayTail | undefined =>
    display.sections[sectionPosition]?.tail;

const flatten = (ops: TurnDisplayOp[][]): TurnDisplayOp[] => ops.flat();

const tailOps = (ops: TurnDisplayOp[][]): TurnDisplayOp[] => flatten(ops).filter((op) => op.op === 'tail:set' || op.op === 'tail:clear');

describe('the designation, block by block', () => {
    it('designates a thinking window and streams it in full, with the segment beside it', () => {
        const result = fold([starts(), think('first thought'), think(' and more')]);

        expect(tailOf(result.display())).toEqual({
            kind: 'reasoning',
            nodeId: 'n1',
            blockId: '0-reasoning-1',
            // The designation-time count; the segment carries the running exact figure.
            chars: 13,
            truncated: false
        });

        // No preview patch arrived, because the block on screen is the whole block: every
        // delta travelled, and only `context:set` moved.
        expect(result.ops[1].filter((op) => op.op === 'node:set')).toEqual([]);
        expect(result.ops[2]).toEqual([
            { op: 'node:append', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', delta: ' and more' },
            {
                op: 'context:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                blockId: '0-reasoning-1',
                patch: { chars: 22, durationMs: 10, eventTo: 2 }
            }
        ]);
    });

    it('streams a window far longer than the node bound whole, while the designation stays put', () => {
        const opening = 'q'.repeat(200);
        const long = 'q'.repeat(DISPLAY_NODE_PREVIEW_CHARS * 4);
        const result = fold([starts(), think(opening), think(long)]);

        // 1,480 characters of thinking on the wire, whole, because it IS the tail.
        expect(result.display().sections[0].nodes[0]).toEqual({
            kind: 'reasoning',
            id: 'n1',
            text: `${opening}${long}`,
            chars: 200 + long.length
        });
        expect(tailOf(result.display())).toMatchObject({ kind: 'reasoning', nodeId: 'n1', truncated: false });

        // ONE designation for two deltas of the same block: the running count rides the
        // segment, so the pointer is never re-sent per token.
        expect(tailOps(result.ops)).toHaveLength(1);
    });

    it('designates the CALL as the tail, with its complete recorded arguments while it runs', () => {
        const args = JSON.stringify({ path: 'notes.md', query: 'what changed', tail: 'x'.repeat(400) });
        const result = fold([starts(), think('planning'), toolCall('call-1', 'read', args)]);

        // R23: "whatever block it is, it is in the tail, like tool call" — the newest block
        // is a call, and a call gets a full body too, not just a segment.
        expect(tailOf(result.display())).toEqual({
            kind: 'tool',
            nodeId: '2',
            blockId: '0-tool-2',
            chars: args.length,
            truncated: false,
            args
        });

        // The thinking window it superseded is history now: bounded wire text, exact length,
        // and the marker the client needs (never inferred from a length comparison).
        expect(result.display().sections[0].nodes[0]).toMatchObject({
            kind: 'reasoning',
            text: 'planning',
            chars: 8
        });

        // The step itself stays a SUMMARY: the rail and every later `step:set` stay small, so
        // the full bytes appear exactly once, on the designation.
        const step = result.display().sections[0].nodes[1] as { argsPreview?: string; preview?: string };

        expect(step.argsPreview).toHaveLength(DISPLAY_ARGS_PREVIEW_CHARS);
        expect(step.preview).toBeUndefined();
        // A running call has no recorded result, and the tail does not claim one.
        expect(tailOf(result.display())?.result).toBeUndefined();
    });

    it('adds the complete recorded result to the SAME designation the moment the call settles', () => {
        const args = '{"path":"notes.md"}';
        const body = 'the whole recorded file body, every line of it';
        const result = fold([
            starts(),
            toolCall('call-1', 'read', args),
            toolResult('read', body, 'call-1', { outcome: 'completed', durationMs: 800 })
        ]);

        expect(tailOf(result.display())).toEqual({
            kind: 'tool',
            nodeId: '1',
            blockId: '0-tool-1',
            chars: args.length + body.length,
            truncated: false,
            args,
            result: body
        });

        // Settling is the second and last publish for this block: the payload moves when the
        // bytes move, and never on an unrelated frame.
        expect(tailOps(result.ops)).toHaveLength(2);
        // The segment's exact split is what the caption prints, so it agrees with the body.
        expect(result.display().sections[0].context?.find((block) => block.id === '0-tool-1')).toMatchObject({
            chars: args.length + body.length,
            argsChars: args.length,
            resultChars: body.length,
            state: 'ok'
        });
    });

    it('carries the call payload while it is the tail, and drops it when the next thinking window takes over', () => {
        // Longer than `DISPLAY_PREVIEW_CHARS`, with the marker in the MIDDLE: a head-truncated
        // step preview can never contain it, so "the payload is gone" is a real assertion and
        // not an accident of a short body fitting inside the summary anyway.
        const body = `${'filler-'.repeat(60)}MIDDLE-OF-THE-RESULT-4c1d${'-tail'.repeat(60)}`;
        const args = `{"path":"notes.md","query":"${'q'.repeat(300)}"}`;
        const result = fold([
            starts(),
            think('first round'),
            toolCall('call-1', 'read', args),
            toolResult('read', body, 'call-1', { outcome: 'completed' }),
            think('second round')
        ]);

        expect(tailOf(result.display())).toMatchObject({ kind: 'reasoning', nodeId: 'n4', blockId: '0-reasoning-4' });

        // Compactness (R23): the compiled view holds ONE full block. The designation moved,
        // so the call's payload is absent from it, and the call node itself stayed the
        // bounded summary it has always been.
        const view = JSON.stringify(result.display());

        expect(view).not.toContain('MIDDLE-OF-THE-RESULT-4c1d');
        expect(result.display().sections[0].tail).not.toHaveProperty('args');
        expect(result.display().sections[0].tail).not.toHaveProperty('result');
        expect(result.display().sections[0].nodes[1]).not.toHaveProperty('args');
        expect((result.display().sections[0].nodes[1] as { preview?: string }).preview).toHaveLength(DISPLAY_PREVIEW_CHARS);

        // The same record WITHOUT the last frame is the moment the payload IS the current
        // block: the marker rides the document exactly once, beside a bounded step.
        const settled = fold([
            starts(),
            think('first round'),
            toolCall('call-1', 'read', args),
            toolResult('read', body, 'call-1', { outcome: 'completed' })
        ]);

        expect(JSON.stringify(settled.display())).toContain('MIDDLE-OF-THE-RESULT-4c1d');
        expect(tailOf(settled.display())).toMatchObject({ kind: 'tool', nodeId: '2', truncated: false });
        expect((settled.display().sections[0].nodes[1] as { preview?: string }).preview).toHaveLength(DISPLAY_PREVIEW_CHARS);
    });

    it('lets the final answer replace the tail, and bounds the thinking it supersedes', () => {
        const answer = 'the complete recorded answer, every line of it';
        const result = fold([
            starts(),
            think('round one'),
            toolCall('call-1', 'read', '{"path":"notes.md"}'),
            toolResult('read', 'file body', 'call-1', { outcome: 'completed' }),
            think('round two'),
            say(answer),
            { type: 'attempt_commit', agent: 'one', attempt: 2, maxAttempts: 3 } as HarnessEvent
        ]);

        expect(tailOf(result.display())).toEqual({
            kind: 'assistant',
            nodeId: 'n5',
            blockId: '0-assistant-5',
            chars: answer.length,
            truncated: false
        });
        // The answer is whole; both thinking windows are previews with exact lengths, and the
        // call's payload is not in the document at all.
        expect(result.display().sections[0].nodes.filter((node) => node.kind === 'reasoning')).toEqual([
            { kind: 'reasoning', id: 'n1', text: 'round one', chars: 9 },
            { kind: 'reasoning', id: 'n4', text: 'round two', chars: 9 }
        ]);
        // The copy pointer still names the answer, and it agrees with the designation.
        expect(result.display().sections[0].answerNodeId).toBe('n5');
    });
});

describe('what may never take the tail', () => {
    it('excludes the system instructions and the user prompt, and still prints them as segments', () => {
        const result = fold([starts()]);

        // Only the two non-content segments exist, and there is no body at all.
        expect(result.display().sections[0].context?.map((block) => block.kind)).toEqual(['system', 'user']);
        expect(tailOf(result.display())).toBeUndefined();
        expect(result.display().sections[0]).not.toHaveProperty('tail');
    });

    it('excludes a steered submit, so the block the reader is on survives guidance', () => {
        const turn = turnOf({ steers: [{ id: 'steer-1', at: 1_015, prompt: 'keep going' }] });
        const result = fold([starts(), think('planning'), say('an answer')], turn);

        expect(result.display().sections[0].context?.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            // The submit was recorded at 1_015, between the two flow events, and the bar
            // places it by that recorded time (R6) — while the tail rule still ignores it.
            '0-reasoning-1',
            '0-user-isteer-1',
            '0-assistant-2'
        ]);
        // The submit is the newest RECORDED TEXT, but a user block is excluded by rule: the
        // answer keeps its body, and the prompt keeps its own row.
        expect(tailOf(result.display())).toMatchObject({ kind: 'assistant', nodeId: 'n2' });
    });

    it('excludes wake, error and answered notices, and the per-section pending line', () => {
        const pending = [{ callId: 'call-2', name: 'watch', elapsedMs: 1_200 }];
        const result = fold([
            starts(),
            say('the answer so far'),
            { type: 'wakeup', agent: 'one', pending } as HarnessEvent,
            { type: 'error', agent: 'one', error: { message: 'upstream 503' } } as HarnessEvent
        ]);

        // The notice nodes are there — the reader sees them — and none of them stole the
        // body. The per-section pending line is one of these notices (`id: 'pending'`), which
        // is exactly why the tail rule reads `kind`, not "the last node in the array".
        expect(result.display().sections[0].nodes.map((node) => [node.kind, node.id])).toEqual([
            ['text', 'n1'],
            ['notice', 'n2'],
            ['notice', 'pending'],
            ['notice', 'n3']
        ]);
        expect(tailOf(result.display())).toMatchObject({ kind: 'assistant', nodeId: 'n1', truncated: false });
        // The error line is verbatim, so a terminal failure is never hidden behind the rule,
        // and the wake/pending lines keep their exact existing tile text beside it.
        expect(result.display().sections[0].nodes.filter((node) => node.kind === 'notice')).toMatchObject([
            { id: 'n2', tone: 'wake', text: '1 tool still running · continuing' },
            { id: 'pending', tone: 'info', text: 'pending · watch 1.2s' },
            { id: 'n3', tone: 'error', text: 'upstream 503' }
        ]);
    });

    it('excludes an owner question, which renders its own full card', () => {
        const result = fold([
            starts(),
            think('planning'),
            {
                type: 'action_request',
                agent: 'one',
                callId: 'call-1',
                request: { requestId: 'req-1', question: 'Which file?', options: [{ id: 'a', label: 'a.ts' }], allowCustom: true }
            } as HarnessEvent
        ]);

        expect(result.display().sections[0].nodes.map((node) => node.kind)).toEqual(['reasoning', 'action']);
        // The question is displayed in full by its card, so it neither needs nor takes a tail.
        expect(tailOf(result.display())).toMatchObject({ kind: 'reasoning', nodeId: 'n1' });
    });
});

describe('root and delegate are independent', () => {
    const childThread = { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', kind: 'delegation' as const, input: 'sub task' };

    const delegated = (): HarnessEvent[] => [
        { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
        think('caller thought'),
        toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two', input: 'sub task' })),
        { type: 'start', agent: 'two', model: 'gpt-y', thread: childThread },
        { type: 'reasoning', agent: 'two', delta: 'callee thought', thread: childThread },
        { type: 'tool_call', agent: 'two', thread: childThread, call: { id: 'call-9', name: 'grep', arguments: '{"q":"x"}' } },
        { type: 'text', agent: 'one', delta: 'caller answer' }
    ];

    it('gives each section its own designation, in its own recorded order', () => {
        const result = fold(delegated());
        const display = result.display();

        expect(display.sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);
        // The caller's newest block is its answer; the callee is still sitting on its call.
        expect(tailOf(display, 0)).toMatchObject({ kind: 'assistant', nodeId: 'n6' });
        expect(tailOf(display, 1)).toMatchObject({ kind: 'tool', nodeId: '5', args: '{"q":"x"}' });
        // A delegated section's payload never lands on its caller's row, and vice versa.
        expect(display.sections[0].tail).not.toHaveProperty('args');
    });

    it('lands the same two designations on a cold reload of the same record', () => {
        const events = delegated();
        const live = fold(events);

        // The cold fold ends where the live run ends, so the comparison is the whole
        // restart path: the record, the replay, and the settle the store applies to a
        // terminal turn.
        live.settle('done');

        const cold = projectTurn(
            turnOf({ status: 'done', updatedAt: 5_000, events: [...events], eventTimes: events.map((_event, index) => timeOf(index)) }),
            SOURCED
        );

        expect(cold.display).toEqual(live.display());
        expect(cold.display.sections.map((section) => section.tail?.kind)).toEqual(['assistant', 'tool']);
    });
});

describe('live, cold and settled agree', () => {
    const sequence = (): HarnessEvent[] => [
        starts(),
        think('a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 90)),
        toolCall('call-1', 'read', '{"path":"notes.md"}'),
        toolResult('read', 'file body', 'call-1', { outcome: 'completed', durationMs: 12 }),
        think('second round of thinking'),
        say('the final answer'),
        { type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 2 } as HarnessEvent
    ];

    it('ends the live stream, the settle and the cold fold on the same designation', () => {
        const events = sequence();
        const live = fold(events);

        live.settle('done');

        const cold = projectTurn(
            turnOf({ status: 'done', updatedAt: 5_000, events: [...events], eventTimes: events.map((_event, index) => timeOf(index)) }),
            SOURCED
        );

        expect(cold.display).toEqual(live.display());
        expect(tailOf(cold.display)).toMatchObject({ kind: 'assistant', nodeId: 'n5' });

        // And every historical body is bounded in both, so a reload replays exactly one.
        for (const display of [cold.display, live.display()]) {
            const reasoning = display.sections[0].nodes.filter((node) => node.kind === 'reasoning') as {
                text: string;
                chars?: number;
                redacted?: boolean;
            }[];

            expect(reasoning[0].redacted).toBe(true);
            expect(reasoning[0].text.length).toBe(DISPLAY_NODE_PREVIEW_CHARS);
            expect(reasoning[0].chars).toBe(DISPLAY_NODE_PREVIEW_CHARS + 90);
            expect(reasoning[1].redacted).toBeUndefined();
        }
    });

    it('shows the thinking in full when a turn ENDS on thinking, live and after settle', () => {
        const events = [starts(), think('a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 40))];
        const live = fold(events);

        live.settle('done');

        const node = live.display().sections[0].nodes[0] as { text: string; chars?: number; redacted?: boolean };

        // R23: the newest block is what shows, and a turn that ends mid-thought leaves that
        // thought readable instead of a 320-character stub.
        expect(node.redacted).toBeUndefined();
        expect(node.text.length).toBe(DISPLAY_NODE_PREVIEW_CHARS + 40);
        expect(tailOf(live.display())).toMatchObject({ kind: 'reasoning', truncated: false });

        const cold = projectTurn(
            turnOf({ status: 'done', updatedAt: 5_000, events: [...events], eventTimes: events.map((_event, index) => timeOf(index)) }),
            SOURCED
        );

        expect(cold.display).toEqual(live.display());
    });

    it('keeps the call as the tail with no invented result when the turn ends around a running call', () => {
        const events = [starts(), think('planning'), toolCall('call-1', 'read', '{"path":"notes.md"}')];
        const live = fold(events);

        live.settle('error');

        expect(tailOf(live.display())).toEqual({
            kind: 'tool',
            nodeId: '2',
            blockId: '0-tool-2',
            chars: '{"path":"notes.md"}'.length,
            truncated: false,
            args: '{"path":"notes.md"}'
        });

        const step = live.display().sections[0].nodes[1] as { state: string; preview?: string };

        // The honest settled-without-a-result state, stated by the step the tail points at:
        // no recorded response bytes, and no fabricated ones.
        expect(step.state).toBe('error');
        expect(step.preview).toBe('the turn ended before this call returned');
    });

    it('shows the failed call with its recorded error text as the current body', () => {
        const result = fold([
            starts(),
            toolCall('call-1', 'read', '{"path":"missing.md"}'),
            toolResult('read', 'ENOENT: no such file or directory', 'call-1', { outcome: 'failed', isError: true, durationMs: 30 })
        ]);

        expect(tailOf(result.display())).toMatchObject({
            kind: 'tool',
            nodeId: '1',
            truncated: false,
            args: '{"path":"missing.md"}',
            result: 'ENOENT: no such file or directory'
        });
        expect(result.display().sections[0].nodes[0]).toMatchObject({ state: 'error', outcome: 'failed' });
    });
});

describe('a discarded attempt hands the tail back exactly', () => {
    it('restores the body the wire had bounded, with the marker withdrawn', () => {
        const first = 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 60);
        const result = fold([
            starts(),
            say(first),
            { type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 3 } as HarnessEvent,
            think('a fresh attempt'),
            toolCall('call-1', 'read', '{}'),
            {
                type: 'retry',
                agent: 'one',
                attempt: 2,
                maxAttempts: 3,
                delayMs: 0,
                error: { message: 'upstream 500' }
            } as HarnessEvent
        ]);

        // The retry erased the block that held the tail, so the committed answer IS the
        // newest eligible node again — and the live wire copy must match the cold document,
        // which carries it whole. One addressed patch, stated, not inferred.
        expect(flatten(result.ops)[flatten(result.ops).length - 2]).toEqual({
            op: 'node:set',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            nodeId: 'n1',
            patch: { text: first, chars: first.length, unredacted: true }
        });
        expect(tailOf(result.display())).toMatchObject({ kind: 'assistant', nodeId: 'n1', truncated: false });

        const node = result.display().sections[0].nodes[0] as { text: string; chars?: number; redacted?: boolean };

        expect(node.text).toBe(first);
        expect(node.redacted).toBeUndefined();
    });
});

describe('the one payload bound that is not the node bound', () => {
    it('states the cap honestly when a recorded argument list exceeds it', () => {
        const args = `{"blob":"${'z'.repeat(DISPLAY_TAIL_PAYLOAD_CHARS + 25)}"}`;
        const result = fold([starts(), toolCall('call-1', 'write', args)]);
        const tail = tailOf(result.display());

        // Full means "as much of the recorded block as the tail contract carries", and the
        // descriptor says so beside the EXACT recorded length — never a silent truncation.
        expect(tail?.args).toBe(args.slice(0, DISPLAY_TAIL_PAYLOAD_CHARS));
        expect(tail?.truncated).toBe(true);
        expect(tail?.chars).toBe(args.length);
        expect(result.display().sections[0].context?.find((block) => block.id === '0-tool-1')).toMatchObject({
            chars: args.length,
            argsChars: args.length
        });
    });

    it('reports a result-only legacy frame as a tool tail with no arguments', () => {
        // A protocol that reports results without calls: the step's opening event IS the
        // result, so the tail states the response and stays silent about arguments (never an
        // invented empty string, and never a claim about bytes the record does not hold).
        const result = fold([starts(), toolResult('read', 'a body with no recorded call', 'call-1', { outcome: 'completed' })]);

        expect(tailOf(result.display())).toEqual({
            kind: 'tool',
            nodeId: '1',
            blockId: '0-tool-1',
            chars: 'a body with no recorded call'.length,
            truncated: false,
            result: 'a body with no recorded call'
        });
    });
});

describe('no designation without a change', () => {
    it('publishes once per block, not once per delta, across a whole round', () => {
        const events: HarnessEvent[] = [starts()];

        for (let index = 0; index < 12; index += 1) events.push(think(`thought ${index} `));
        events.push(toolCall('call-1', 'read', '{"path":"notes.md"}'));
        events.push(toolResult('read', 'body', 'call-1', { outcome: 'completed' }));
        for (let index = 0; index < 8; index += 1) events.push(say(`answer ${index} `));

        const result = fold(events);

        // thinking (1) -> call (1) -> result settles the call (1) -> answer (1)
        expect(tailOps(result.ops)).toHaveLength(4);
        expect(flatten(result.ops).filter((op) => op.op === 'tail:set').map((op) => (op as { tail: DisplayTail }).tail.kind)).toEqual([
            'reasoning',
            'tool',
            'tool',
            'assistant'
        ]);
        expect(tailOf(result.display())).toMatchObject({ kind: 'assistant', nodeId: 'n15' });
    });
});

// The sections of a display, addressed by id — the shape every assertion above reads.
const sectionsOf = (display: TurnDisplay): TurnSection[] => display.sections;

describe('the compiled document', () => {
    it('carries the designation on the section, so a cold view needs no client rule at all', () => {
        const result = fold([starts(), think('only thinking')]);
        const [root] = sectionsOf(result.display());

        expect(root?.tail).toEqual({
            kind: 'reasoning',
            nodeId: 'n1',
            blockId: '0-reasoning-1',
            chars: 'only thinking'.length,
            truncated: false
        });
        // The pointer to the copy target is untouched by this contract: it stays the answer
        // pointer it always was, and a section with no answer carries nothing.
        expect(root.answerNodeId).toBeUndefined();
    });
});
