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
//   - one designated body per section, root and delegate independent, and a superseded
//     payload is DROPPED from the compiled view in the frame that replaced it;
//   - R2 (T1) adds exactly one more whole body: the section's NEWEST ANSWER keeps its full
//     text even while a later reasoning window or call holds the tail, so the board can print
//     that response above the current block. An answer goes preview-sized only when a NEWER
//     ANSWER supersedes it, and no extra body is re-sent on a frame that did not move the
//     designation;
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
    DISPLAY_PREVIEW_CHARS
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

// R2 (T1), the SERVER half: a running turn shows the newest assistant response ABOVE the block
// that currently holds the tail (the tool call or the reasoning window), so the newest
// `kind: 'text'` node of every section must travel as a full-text carrier EVEN THOUGH a later
// node holds `TurnSection.tail`. The browser reads that carrier off `section.nodes` order and
// the absence of `redacted` — there is no second designation and no new wire field
// (../server/turn-projector.ts `isFullCarrier`).
describe('the newest answer is a second full carrier', () => {
    // Every body below is deliberately LONGER than `DISPLAY_NODE_PREVIEW_CHARS`, so "full" and
    // "preview" are distinguishable and no assertion passes by accident of a short string.
    const long = 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 80);
    const longB = 'b'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 80);
    const preview = (letter: string) => `\u2026${letter.repeat(DISPLAY_NODE_PREVIEW_CHARS - 1)}`;

    it('carries an answer whole while it IS the tail (the rule this one inherits)', () => {
        const result = fold([starts(), say(long)]);

        expect(result.display().sections[0].nodes).toEqual([{ kind: 'text', id: 'n1', text: long, committed: false, chars: long.length }]);
        expect(tailOf(result.display())).toEqual({
            kind: 'assistant',
            nodeId: 'n1',
            blockId: '0-assistant-1',
            chars: long.length,
            truncated: false
        });
    });

    it('keeps the answer full and unredacted when a thinking window takes the tail', () => {
        const window = 'a newer window of thinking';
        const result = fold([starts(), say(long), think(window)]);

        // The designation moved to the window; the answer did NOT become a preview, and the
        // window itself is still the whole body the reader is looking at.
        expect(result.display().sections[0].nodes[0]).toEqual({
            kind: 'text',
            id: 'n1',
            text: long,
            committed: false,
            chars: long.length
        });
        expect(result.display().sections[0].nodes[1]).toEqual({ kind: 'reasoning', id: 'n2', text: window, chars: window.length });
        expect(tailOf(result.display())).toEqual({
            kind: 'reasoning',
            nodeId: 'n2',
            blockId: '0-reasoning-2',
            chars: window.length,
            truncated: false
        });

        // Not one patch touched the answer's body across the whole round: the bytes it streamed
        // while it held the tail ARE its wire copy, forever, until an answer replaces them.
        expect(flatten(result.ops).filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([]);
    });

    it('keeps the answer full and unredacted when a tool call takes the tail', () => {
        const args = JSON.stringify({ path: 'notes.md', body: 'x'.repeat(400) });
        const result = fold([starts(), say(long), toolCall('call-1', 'read', args)]);

        expect(result.display().sections[0].nodes[0]).toEqual({
            kind: 'text',
            id: 'n1',
            text: long,
            committed: false,
            chars: long.length
        });
        // The call is the designated body, with its complete recorded request — the answer above
        // it is displayed by the SECOND carrier rule, not by this designation.
        expect(tailOf(result.display())).toEqual({
            kind: 'tool',
            nodeId: '2',
            blockId: '0-tool-2',
            chars: args.length,
            truncated: false,
            args
        });
        expect(flatten(result.ops).filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([]);
    });

    it('bounds the older answer in the very frame a NEWER answer takes the tail', () => {
        const result = fold([
            starts(),
            say(long),
            toolCall('call-1', 'read', '{}'),
            toolResult('read', 'r', 'call-1', { outcome: 'completed' }),
            say(longB)
        ]);

        // R2's carrier slot holds ONE node: the superseded answer is hidden by the newer one
        // client-side, so it goes back to being history — bounded, exact length, marker set —
        // and it happens in the frame the newer answer is recorded, not one frame earlier.
        expect(result.display().sections[0].nodes[0]).toEqual({
            kind: 'text',
            id: 'n1',
            text: preview('a'),
            committed: false,
            chars: long.length,
            redacted: true
        });
        expect(result.display().sections[0].nodes[2]).toEqual({
            kind: 'text',
            id: 'n4',
            text: longB,
            committed: false,
            chars: longB.length
        });
        expect(tailOf(result.display())).toEqual({
            kind: 'assistant',
            nodeId: 'n4',
            blockId: '0-assistant-4',
            chars: longB.length,
            truncated: false
        });

        // The preview is the tail of the recorded text (T26), and the op stream says so once.
        expect(flatten(result.ops).filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: preview('a'), chars: long.length, redacted: true }
            }
        ]);
    });

    it('still bounds every non-text block it always bounded, and pays nothing extra per frame', () => {
        const window = 'q'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 80);
        const result = fold([starts(), say(long), think(window), toolCall('call-1', 'read', '{}')]);

        // A thinking window is NOT a second carrier: it loses its body the moment the call takes
        // the tail, exactly as it did before R2.
        expect(result.display().sections[0].nodes[1]).toEqual({
            kind: 'reasoning',
            id: 'n2',
            text: preview('q'),
            chars: window.length,
            redacted: true
        });
        // The answer survives BOTH supersessions whole.
        expect(result.display().sections[0].nodes[0]).toEqual({
            kind: 'text',
            id: 'n1',
            text: long,
            committed: false,
            chars: long.length
        });

        // Across the whole round the frame-end pass emits exactly one body patch — the window's.
        // The new carrier costs no traffic of its own, because its bytes already streamed while
        // it held the tail and nothing about it moved (`tailStampOf` still gates the pass).
        expect(flatten(result.ops).filter((op) => op.op === 'node:set').map((op) => (op as { nodeId: string }).nodeId)).toEqual([
            'n2'
        ]);
    });

    it('lands the same second carrier on a cold reload of the same record', () => {
        const events = [starts(), say(long), toolCall('call-1', 'read', '{}')];
        const live = fold(events);

        live.settle('done');

        const cold = projectTurn(
            turnOf({ status: 'done', updatedAt: 5_000, events: [...events], eventTimes: events.map((_event, index) => timeOf(index)) }),
            SOURCED
        );

        // Hydration reads the whole `TurnDisplay`, not the ops: the reloaded document carries the
        // answer in full beside the settled call it designates, so a reload cannot show a stub the
        // live stream never sent.
        expect(cold.display).toEqual(live.display());
        expect(cold.display.sections[0].nodes[0]).toEqual({ kind: 'text', id: 'n1', text: long, committed: false, chars: long.length });
        expect(cold.display.sections[0].tail).toMatchObject({ kind: 'tool', nodeId: '2' });
    });
});

// P3 (the review of R2): the newest answer is now read from a PER-SECTION CACHE
// (`SectionRecord.latestTextNodeId`) instead of a backward scan per prose node per projection,
// so correctness depends on EVERY site that adds or removes a node keeping that cache exact.
// Each case below is one of those sites; none of them may cost the answer its whole body, and
// the removal site must hand the status BACK rather than leave a preview behind.
describe('the second carrier survives every node mutation the fold makes', () => {
    const answer = 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 40);

    const answerOf = (display: TurnDisplay) => display.sections[0].nodes.find((node) => node.kind === 'text');

    const whole = (committed: boolean) => ({
        kind: 'text',
        id: 'n1',
        text: answer,
        committed,
        chars: answer.length
    });

    it('across a step append (`pushStep` appends a row, never prose)', () => {
        expect(answerOf(fold([starts(), say(answer), toolCall('call-1', 'read', '{}')]).display())).toEqual(whole(false));
    });

    it('across the pending line arriving AND being removed (`syncPendingLine`, both directions)', () => {
        // The wake notice and the composed pending line JOIN the array; the settled call then
        // drains the snapshot, and `syncPendingLine`'s filter takes the pending node back OUT —
        // the one removal that runs on an ordinary frame. It must not leave the carrier cache
        // naming a node that no longer exists (that would cost the surviving answer its body).
        // The prune is keyed to a call the record actually opened, so the call is recorded here.
        const display = fold([
            starts(),
            say(answer),
            { type: 'wakeup', agent: 'one', pending: [{ callId: 'call-9', name: 'watch', elapsedMs: 1_200 }] } as HarnessEvent,
            toolCall('call-9', 'watch', '{}'),
            toolResult('watch', 'it finished', 'call-9', { outcome: 'completed' })
        ]).display();

        // The pending line is gone, the wake notice and the row are not, and the answer that
        // predates all three is still whole.
        expect(display.sections[0].nodes.map((node) => [node.kind, node.id])).toEqual([
            ['text', 'n1'],
            ['notice', 'n2'],
            ['tool', '3']
        ]);
        expect(answerOf(display)).toEqual(whole(false));
    });
    it('across a discarded attempt that removes the newest answer (`discardAttempt` re-derives)', () => {
        const second = 'b'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 40);
        const result = fold([
            starts(),
            say(answer),
            { type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 3 } as HarnessEvent,
            think('a committed window'),
            { type: 'attempt_commit', agent: 'one', attempt: 2, maxAttempts: 3 } as HarnessEvent,
            say(second),
            {
                type: 'retry',
                agent: 'one',
                attempt: 3,
                maxAttempts: 3,
                delayMs: 0,
                error: { message: 'upstream 500' }
            } as HarnessEvent
        ]);

        // The retry erases `n5` but NOT the thinking window that now holds the tail, so the
        // surviving answer regains carrier status by RULE 2 alone: bounded when `n5` superseded
        // it, restored when the discard re-derives the newest answer. A stale cache would leave
        // the middle preview in place and never send the third patch.
        expect(flatten(result.ops).filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([
            { op: 'node:set', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', patch: { committed: true } },
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: `\u2026${'a'.repeat(319)}`, chars: answer.length, redacted: true }
            },
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: answer, chars: answer.length, unredacted: true }
            }
        ]);
        // The erased node is gone and the DESIGNATED body is the surviving think window — the
        // answer above it is whole because of the cache, not because of the tail.
        expect(result.display().sections[0].nodes.map((node) => [node.kind, node.id])).toEqual([
            ['text', 'n1'],
            ['reasoning', 'n3']
        ]);
        expect(tailOf(result.display())).toMatchObject({ kind: 'reasoning', nodeId: 'n3' });
        expect(answerOf(result.display())).toEqual(whole(true));
    });
});

// P3's shape, pinned as traffic instead of a stopwatch: 200 calls settled AFTER the newest
// answer used to make every projection walk 400 rows per prose node. The answer must stay whole
// through all of them while costing the wire NOTHING for those frames — a cached read, not a
// re-send, and not a re-scan.
describe('a long call run after the newest answer', () => {
    it('keeps that answer whole with no body traffic for it across 400 later frames', () => {
        const answer = 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 40);
        const events: HarnessEvent[] = [starts(), say(answer)];

        for (let index = 0; index < 200; index += 1) {
            events.push(toolCall(`call-${index}`, 'read', `{"n":${index}}`));
            events.push(toolResult('read', `body ${index}`, `call-${index}`, { outcome: 'completed' }));
        }

        const result = fold(events);
        const document = result.display();

        expect(document.sections[0].nodes[0]).toEqual({ kind: 'text', id: 'n1', text: answer, committed: false, chars: answer.length });
        expect(document.sections[0].nodes).toHaveLength(201);
        expect(document.sections[0].tail).toMatchObject({ kind: 'tool', nodeId: '400', result: 'body 199' });

        // The answer travelled exactly once (its own delta): 400 call frames moved the
        // designation 400 times and never re-sent or re-bounded that body.
        const ops = flatten(result.ops);

        expect(ops.filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([]);
        expect(ops.filter((op) => op.op === 'node:append' && op.nodeId === 'n1')).toHaveLength(1);
        expect(ops.filter((op) => op.op === 'tail:set')).toHaveLength(401);

        // And reading the compiled document is a pure, repeatable projection of that cache.
        expect(result.display()).toEqual(document);
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

    it('gives each section its own second full carrier, independently (R2, T1)', () => {
        const callerAnswer = 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 40);
        const calleeAnswer = 'b'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 40);
        const display = fold([
            { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
            say(callerAnswer),
            toolCall('call-1', 'delegate', JSON.stringify({ agent: 'two', input: 'sub task' })),
            { type: 'start', agent: 'two', model: 'gpt-y', thread: childThread },
            { type: 'text', agent: 'two', delta: calleeAnswer, thread: childThread },
            { type: 'tool_call', agent: 'two', thread: childThread, call: { id: 'call-9', name: 'grep', arguments: '{"q":"x"}' } }
        ]).display();

        // Both sections are sitting on a CALL, so NEITHER answer is the designated tail — and
        // each section still carries ITS OWN newest answer whole. The rule is per
        // `SectionRecord`, so a callee's body never satisfies the caller's carrier slot.
        expect(display.sections.map((section) => section.tail?.kind)).toEqual(['tool', 'tool']);
        expect(display.sections[0].nodes[0]).toEqual({
            kind: 'text',
            id: 'n1',
            text: callerAnswer,
            committed: false,
            chars: callerAnswer.length
        });
        expect(display.sections[1].nodes[0]).toEqual({
            kind: 'text',
            id: 'n4',
            text: calleeAnswer,
            committed: false,
            chars: calleeAnswer.length
        });
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
    it('never bounds an answer a call superseded, so the retry that hands the tail back has nothing to restore', () => {
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

        // R2 (T1): this answer was superseded by a THINKING WINDOW and a CALL, never by another
        // answer, so the wire never bounded it — and there is no restore patch to make, because
        // the body the retry hands back is the body the client still holds. (The only patch this
        // stream ever sends for `n1` is its `committed` flag.)
        expect(flatten(result.ops).filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([
            { op: 'node:set', turnId: 'turn-1', sectionId: 'turn-1:0', nodeId: 'n1', patch: { committed: true } }
        ]);

        // The designation still moves back, and it is still the last op of the frame that erased
        // the block that held it: a client never holds a tail naming a node it has not received.
        const ops = flatten(result.ops);

        expect(ops[ops.length - 1]).toEqual({
            op: 'tail:set',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            tail: { kind: 'assistant', nodeId: 'n1', blockId: '0-assistant-1', chars: first.length, truncated: false }
        });
        expect(tailOf(result.display())).toMatchObject({ kind: 'assistant', nodeId: 'n1', truncated: false });

        const node = result.display().sections[0].nodes[0] as { text: string; chars?: number; redacted?: boolean };

        expect(node.text).toBe(first);
        expect(node.redacted).toBeUndefined();
    });

    it('restores a body the wire HAD bounded, with the marker withdrawn', () => {
        // The only supersession that bounds an answer is a newer ANSWER (R2, T1), so this is the
        // sequence that exercises the restore: `first` loses its body when `second` takes the
        // tail, and gets it back verbatim when the retry erases `second`.
        const first = 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 60);
        const second = 'b'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 60);
        const result = fold([
            starts(),
            say(first),
            { type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 3 } as HarnessEvent,
            think('a fresh attempt'),
            say(second),
            {
                type: 'retry',
                agent: 'one',
                attempt: 2,
                maxAttempts: 3,
                delayMs: 0,
                error: { message: 'upstream 500' }
            } as HarnessEvent
        ]);

        // Bounded once, in the frame the newer answer was recorded — not in the frame the thinking
        // window took the tail (R2 keeps `n1` whole through that one).
        expect(result.ops[3].filter((op) => op.op === 'node:set')).toEqual([]);
        expect(result.ops[4].filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: `\u2026${'a'.repeat(319)}`, chars: first.length, redacted: true }
            }
        ]);

        // The retry erased the block that held the tail, so the committed answer IS the newest
        // eligible node again — and the live wire copy must match the cold document, which
        // carries it whole. One addressed patch, stated, not inferred.
        expect(result.ops[5].filter((op) => op.op === 'node:set' && op.nodeId === 'n1')).toEqual([
            {
                op: 'node:set',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                nodeId: 'n1',
                patch: { text: first, chars: first.length, unredacted: true }
            }
        ]);
        expect(tailOf(result.display())).toMatchObject({ kind: 'assistant', nodeId: 'n1', truncated: false });

        const node = result.display().sections[0].nodes[0] as { text: string; chars?: number; redacted?: boolean };

        expect(node.text).toBe(first);
        expect(node.redacted).toBeUndefined();
    });
});

// T25 (R23): the designated payload IS the recorded payload. The display contract used to
// cap a tail field at 64 KiB of its own, which silently re-truncated the ONE block it
// promises to print in full — `tool_call.arguments` carries no runtime cap at all (only a
// model-facing result does, ../core/result-budget.ts:42), so a 70 KiB write call lost
// 6 KiB of its request while the caption claimed the block was whole.
describe('the designated payload is the recorded payload, exactly', () => {
    it('reproduces an argument list past any display bound without a second truncation', () => {
        const args = `{"blob":"${'z'.repeat(70 * 1024)}"}`;
        const result = fold([starts(), toolCall('call-1', 'write', args)]);
        const tail = tailOf(result.display());

        // Full means every recorded byte of the current block, and `truncated` stays false
        // because nothing was left behind — beside the EXACT length invariant 5 keeps.
        expect(tail?.args).toBe(args);
        expect(tail?.truncated).toBe(false);
        expect(tail?.chars).toBe(args.length);
        expect(result.display().sections[0].context?.find((block) => block.id === '0-tool-1')).toMatchObject({
            chars: args.length,
            argsChars: args.length
        });
        // The payload still travels ONCE: the step row keeps its own bounded previews, so a
        // rail or a re-issued `step:set` never carries the megabyte the tail does.
        expect(
            (result.display().sections[0].nodes[0] as { argsPreview?: string }).argsPreview
        ).toHaveLength(DISPLAY_ARGS_PREVIEW_CHARS);
    });

    it('reproduces an oversized recorded result verbatim once the call settles', () => {
        // A result longer than the runtime's own 64 KiB budget (a record written before the
        // budget existed, or a tool that bounds itself differently): the tail QUOTES the
        // record, it never re-edits it, and the descriptor says nothing was dropped.
        const body = `${'r'.repeat(66 * 1024)}RESULT-END-4c1d`;
        const result = fold([
            starts(),
            toolCall('call-1', 'read', '{}'),
            toolResult('read', body, 'call-1', { outcome: 'completed' })
        ]);

        expect(tailOf(result.display())).toEqual({
            kind: 'tool',
            nodeId: '1',
            blockId: '0-tool-1',
            chars: 2 + body.length,
            truncated: false,
            args: '{}',
            result: body
        });
        // Two designations for one call — the request, then the response — and no third one
        // for the bytes that did not move.
        expect(tailOps(result.ops)).toHaveLength(2);
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
