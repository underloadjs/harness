// T13: the ONE thing the display wire promises and no unit file proved — a LIVE op stream
// and a COLD reload must land the browser on the SAME document.
//
// The projector is the single fold (../server/turn-projector.ts:10-15: "live and replay are
// the same code path"), and `TurnDisplay` is what a reload hands the client. So the ops a
// live run sends, applied by this browser's reducer (`applyOpToDisplay`), must produce a tree
// that equals the cold `display()` byte for byte — including the bounded node texts and the
// exact `chars` figures beside them.
//
// What this file caught (the defect it now pins)
// ---------------------------------------------
// The projector delivers a think window's bounded preview and a superseded answer's preview
// inside a `node:set` patch, and it stamps every prose node's `chars` when it redacts. The
// reducer applied `chars`/`redacted` but refused `patch.text` for prose ("content moves only
// through `node:append`"), so a live tree kept an EMPTY think body where the reload showed a
// 320-character preview, kept a superseded answer expanded where the reload collapsed it, and
// left `chars: 0` on a streaming answer where the reload reported the real length. The wire
// contract is on the producer's side (`DisplayNodePatch`, ../shared/turn-display.ts:715):
// `text` is an ADDRESSED, SERVER-STATED replacement, and applying it is rendering server
// state — not client compilation.
//
// Why importing the projector here is not a second opinion
// --------------------------------------------------------
// `view-test-support.ts` already drives the SERVER'S projector for the shell's end-to-end
// files (that file's own header explains it). This file is the parity claim itself, so it must
// use the real producer; the reducer's own rules are pinned independently, straight from the
// contract, in ./view-state.test.ts and ./ui/turns-compiled.test.ts.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-state-live-parity.test.ts

import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplay, TurnDisplayOp } from '../shared/turn-display';
import { createTurnProjector } from '../server/turn-projector';
import type { SessionTurn } from '../server/protocol';
import type { HarnessPendingTool } from '../types';
import { describe, expect, it } from 'vitest';
import { applyOpToDisplay, type PendingSections } from './view-state';
import { contextBarOf } from './view-context';

const T = 1_700_000_000_000;

// One event per 10 ms, so every duration in the tree is an assertable exact number.
const timeOf = (index: number): number => T + index * 10;

const INSTRUCTION = 'You are the entry agent.';

const CONTEXT: DisplayProjectContext = {
    primary: 'instruct',
    // The store owns the instruction evidence; the fold may not invent it
    // (../shared/turn-display.ts `DisplayProjectContext.instructionSourcesOf`).
    instructionSourcesOf: () => [{ agent: 'instruct', instructions: [INSTRUCTION], at: T }]
};

const turnOf = (): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'do the thing',
    status: 'running',
    startedAt: T,
    updatedAt: T,
    events: [],
    eventTimes: []
});

// A 515-character think burst delivered in ONE delta: the first frame already crosses the
// `DISPLAY_NODE_PREVIEW_CHARS` cap, which is the shape that used to leave the live chip with
// no bytes at all (the projector inserts an empty node and then replaces its text).
const THINKING = `thinking-about-${'x'.repeat(500)}`;
const FIRST_ANSWER = 'a'.repeat(400);
const FINAL_ANSWER = 'LATEST answer text';
const ARGS = '{"path":"src/main.ts"}';
const RESULT = 'file body';

// reasoning -> one tool round -> first answer -> a newer answer that supersedes it.
const SCRIPT: HarnessEvent[] = [
    { type: 'start', agent: 'instruct', model: 'm1' },
    { type: 'reasoning', agent: 'instruct', delta: THINKING },
    {
        type: 'done',
        agent: 'instruct',
        message: { role: 'assistant', content: '', model: 'm1', stopReason: 'tool_calls', toolCalls: [] },
        usage: { input: 500, output: 20, total: 520 }
    },
    { type: 'tool_call', agent: 'instruct', call: { id: 'call-1', name: 'read', arguments: ARGS } },
    {
        type: 'tool_result',
        agent: 'instruct',
        name: 'read',
        content: RESULT,
        isError: false,
        callId: 'call-1',
        outcome: 'completed',
        durationMs: 25
    },
    { type: 'text', agent: 'instruct', delta: FIRST_ANSWER },
    {
        type: 'done',
        agent: 'instruct',
        message: { role: 'assistant', content: FIRST_ANSWER, model: 'm1', stopReason: 'stop', toolCalls: [] },
        usage: { input: 620, output: 25, total: 645 }
    },
    { type: 'text', agent: 'instruct', delta: FINAL_ANSWER },
    {
        type: 'done',
        agent: 'instruct',
        message: { role: 'assistant', content: FINAL_ANSWER, model: 'm1', stopReason: 'stop', toolCalls: [] },
        usage: { input: 700, output: 30, total: 730 }
    }
];

/**
 * Fold the SAME recorded events twice: once the way a live run does (one `apply` per event,
 * the returned ops handed to a client that mutates its tree), once the way a reload does
 * (the store folds the finished record and answers with `display()`).
 */
const runBothPaths = (): { live: TurnDisplay; cold: TurnDisplay; ops: TurnDisplayOp[] } => {
    const liveRecord = turnOf();
    const coldRecord = turnOf();
    const live = createTurnProjector(liveRecord, CONTEXT);
    const cold = createTurnProjector(coldRecord, CONTEXT);

    const ops: TurnDisplayOp[] = [];

    SCRIPT.forEach((event, index) => {
        liveRecord.events.push(event);
        liveRecord.eventTimes?.push(timeOf(index));
        coldRecord.events.push(event);
        coldRecord.eventTimes?.push(timeOf(index));

        ops.push(...live.apply(event, timeOf(index), index));
        cold.apply(event, timeOf(index), index);
    });

    const lastStamp = timeOf(SCRIPT.length);

    ops.push(...live.settle('done', lastStamp));
    cold.settle('done', lastStamp);

    // The client's starting point is the document the observer opened with: an empty tree
    // for this turn (a fresh submit), mutated ONLY by the ops above.
    const tree: TurnDisplay = { turnId: 't1', sections: [] };
    const pending: PendingSections = new Map();

    for (const op of ops) applyOpToDisplay(tree, 't1', op, pending);

    return { live: tree, cold: cold.display(), ops };
};

const nodes = (display: TurnDisplay): Record<string, unknown>[] =>
    display.sections[0].nodes.map((node) => node as unknown as Record<string, unknown>);

const proseNodes = (display: TurnDisplay) =>
    display.sections[0].nodes
        .filter((node) => node.kind === 'text')
        .map((node) => node as { id: string; text: string; chars?: number; redacted?: true; committed: boolean });

const reasoningNodes = (display: TurnDisplay) =>
    display.sections[0].nodes
        .filter((node) => node.kind === 'reasoning')
        .map((node) => node as { id: string; text: string; chars?: number; redacted?: true });

describe('the ops a live run sends rebuild the exact tree a reload receives', () => {
    const { live, cold } = runBothPaths();

    it('ends with one identical document, not two trees that happen to agree on ids', () => {
        // The whole section list, deep: nodes, steps, the context bar, the answer pointer and
        // every metadata figure. This is the assertion the defect failed.
        expect(live.sections).toEqual(cold.sections);
        expect(live.turnId).toBe(cold.turnId);

        // The one documented difference: `lastSectionOrdinal` is an OPTIONAL partial-view
        // counter (turn-display.ts:823-826) the reducer keeps from the `section:open` ops,
        // while a full `display()` never needs to send it. Asserted, not hidden.
        expect(live.lastSectionOrdinal).toBe(0);
        expect(Object.hasOwn(cold, 'lastSectionOrdinal')).toBe(false);
    });

    it('delivers the bounded think text and its exact length through the ops', () => {
        const [liveThink] = reasoningNodes(live);
        const [coldThink] = reasoningNodes(cold);

        // 320 characters of LATEST-kept preview (T26, R26: the newest bytes survive the bound,
        // so a reconnect replays what the reader was watching rather than the opening line)
        // plus the marker, and the FULL recorded length beside it — never the preview's length,
        // and never an empty body.
        expect(liveThink.text).toBe(`\u2026${THINKING.slice(-319)}`);
        expect(liveThink.text.length).toBe(320);
        expect(liveThink.chars).toBe(THINKING.length);
        expect(liveThink.redacted).toBe(true);
        expect(liveThink).toEqual(coldThink);
    });

    it('collapses a superseded answer through the ops, and keeps the current one in full', () => {
        const liveProse = proseNodes(live);
        const [superseded, current] = liveProse;

        // The older answer: latest-kept preview bytes + its true length + the marker, exactly
        // what the reload's tree carries.
        expect(superseded.text).toBe(`\u2026${'a'.repeat(319)}`);
        expect(superseded.chars).toBe(FIRST_ANSWER.length);
        expect(superseded.redacted).toBe(true);

        // The current answer travels complete, and `chars` equals its text — the contract's
        // stated equality while a node is un-redacted (turn-display.ts:659-666). Live must
        // converge on the same figure the reload reports, not `0`.
        expect(current.text).toBe(FINAL_ANSWER);
        expect(current.chars).toBe(FINAL_ANSWER.length);
        expect(current.redacted).toBeUndefined();
        expect(current.committed).toBe(true);

        expect(liveProse).toEqual(proseNodes(cold));
        expect(cold.sections[0].answerNodeId).toBe(current.id);
        expect(live.sections[0].answerNodeId).toBe(current.id);
    });

    it('keeps the context bar metadata identical through the ops path', () => {
        const liveBar = contextBarOf(live);
        const coldBar = contextBarOf(cold);

        // Identity, order and counts come from the server on both paths; the renderer still
        // compiles nothing.
        expect(liveBar.blocks.map((block) => [block.kind, block.id, block.chars])).toEqual(
            coldBar.blocks.map((block) => [block.kind, block.id, block.chars])
        );
        expect(liveBar.totalChars).toBe(coldBar.totalChars);
        expect(liveBar.counts).toEqual(coldBar.counts);
        expect(liveBar.charsByKind).toEqual(coldBar.charsByKind);

        // The figures themselves, pinned from the recorded bytes (invariant 5): every
        // segment counts its own text once.
        expect(liveBar.blocks.map((block) => [block.kind, block.name, block.chars])).toEqual([
            ['system', 'instructions', INSTRUCTION.length],
            ['user', 'prompt', 'do the thing'.length],
            ['reasoning', 'reasoning', THINKING.length],
            ['tool', 'read', ARGS.length + RESULT.length],
            ['assistant', 'answer', FIRST_ANSWER.length],
            ['assistant', 'answer', FINAL_ANSWER.length]
        ]);
        expect(liveBar.totalChars).toBe(
            INSTRUCTION.length + 'do the thing'.length + THINKING.length + ARGS.length + RESULT.length + FIRST_ANSWER.length + FINAL_ANSWER.length
        );

        // A settled tool segment is green metadata, never a re-derivation.
        const tool = liveBar.blocks.find((block) => block.kind === 'tool');
        expect(tool?.state).toBe('ok');
        expect(tool?.argsChars).toBe(ARGS.length);
        expect(tool?.resultChars).toBe(RESULT.length);
        expect(tool?.durationMs).toBe(25);
    });

    it('leaves no node whose wire text the two paths disagree about', () => {
        // A belt for future regressions: compare the visible text of every node, keyed by id,
        // so a single regression in one kind names itself instead of failing a deep compare.
        const liveText = new Map(nodes(live).map((node) => [String(node.id), node.text]));
        const coldText = new Map(nodes(cold).map((node) => [String(node.id), node.text]));

        expect([...coldText.keys()].sort()).toEqual([...liveText.keys()].sort());
        for (const [id, value] of coldText) expect(liveText.get(id)).toBe(value);
    });
});
