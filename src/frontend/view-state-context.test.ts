// The `context:*` op reducer and the T9 node patch (T11, R6/R7 state half).
//
// The bar's data lives on `TurnSection.context`, and the projector mutates it the same way it
// mutates a section's nodes: ADDRESSED by turn + section + block id, with every count a FULL
// replacement. This file pins that contract on the state side, so the DOM tests
// (`ui/turns-context-bar.test.ts`) can assume the tree they are handed is the server's.
//
// Every fixture is a hand-written `TurnDisplay`/`ContextBlock` (../shared/turn-display.ts),
// and every assertion is the exact resulting array — not "it contains something".
//
// T23 (R23) adds the ownership half of `node:insert`: the document adopts its OWN copy of an
// inserted node, because the same ops array is replayed against the DOM after this reducer has
// mutated the tree, and an R23 tail frame streams a prose node (`insert` empty, then `append`).
//
// R7 (T4a) adds `included` to the `context:set` whitelist: it is the one non-count field on a
// block, and the only figure that can move AFTER the segment is on screen (the segment dialog's
// toggle, or `turn.before setIncluded`). The pins below are the tri-state — `false` dims the bar,
// `true` un-dims it, and a patch that omits the key leaves it exactly as it was, INCLUDING
// leaving it absent.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-state-context.test.ts

import type { ContextBlock, ContextBlockPatch, DisplayNode, TurnDisplay, TurnDisplayOp, TurnSection } from '../shared/turn-display';
import { applyOpToDisplay, applyOpsToActivity } from './view-state';
import { describe, expect, it } from 'vitest';

const T = 1_700_000_000_000;

const block = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
    kind: 'tool',
    id: '0-tool-7',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'read',
    chars: 1204,
    argsChars: 20,
    resultChars: 1184,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9,
    at: T,
    endedAt: T + 800,
    ...overrides
});

const section = (overrides: Partial<TurnSection> = {}): TurnSection => ({
    id: 't1:0',
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'RR1',
    state: 'streaming',
    nodes: [],
    ...overrides
});

const displayOf = (sections: TurnSection[]): TurnDisplay => ({ turnId: 't1', sections });

const pending = new Map<string, never[]>();

const apply = (display: TurnDisplay, op: TurnDisplayOp): boolean =>
    applyOpToDisplay(display, 't1', op, pending as never);

// ---------------------------------------------------------------------------
// context:add
// ---------------------------------------------------------------------------

describe('context:add', () => {
    it('defines the array on a section that had none, and appends in order', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() })).toBe(true);
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['0-tool-7']);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ id: '0-tool-12' }) });
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['0-tool-7', '0-tool-12']);
    });

    it('honors an explicit index for an out-of-order recovery, and ignores one out of range', () => {
        const display = displayOf([section({ context: [block({ id: 'a' }), block({ id: 'c' })] })]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ id: 'b' }), index: 1 });
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ id: 'd' }), index: 99 });
        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ id: 'e' }), index: -1 });
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('replaces a re-delivered add instead of minting a second segment', () => {
        // A reconnect replaying a frame must not double the bar's characters.
        const display = displayOf([section({ context: [block({ chars: 100 })] })]);

        expect(apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ chars: 1204 }) })).toBe(true);

        expect(display.sections[0].context).toEqual([block({ chars: 1204 })]);
    });

    it('keeps a stamped included:false through a re-delivered add that restates nothing (FIX E)', () => {
        // The bar's verdict is the ONE field the tree holds WITHOUT the frame that minted it: the
        // display route joins it live from the transcript (src/server/api.ts `contextSegmentIncludedOf`)
        // and a toggle republishes it as a `context:set` patch. A re-delivered `context:add` for the
        // SAME id (a replay after a reconnect, a `turn:start` of the same turn, a display rebuild that
        // keeps the turn's id) carries the projector's COMPILED fold, which mints no verdict at all —
        // so a plain slot assignment dropped the verdict and the segment un-dimmed with nothing left to
        // switch, and no repaint brought it back until some later display read happened to re-stamp it.
        const withheld = block({ id: '0-tool-7', included: false });
        const display = displayOf([section({ context: [withheld] })]);

        expect(apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() })).toBe(true);

        // Byte-for-byte the withheld record, not a fresh copy of the fold.
        expect(display.sections[0].context).toEqual([withheld]);
    });

    it('obeys a re-delivered add that DOES state the verdict, in both directions', () => {
        // Carrying the verdict over is not sticky local state: a frame that names `included` replaces
        // it wholesale, exactly like every other field on the record. `true` un-dims (the entry is back
        // in the requests that follow), an explicit `false` wins over a tree still saying ON, and a
        // frame that omits the key again leaves the stated verdict standing.
        const display = displayOf([section({ context: [block({ included: false })] })]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ included: true }) });
        expect(display.sections[0].context).toEqual([block({ included: true })]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() });
        expect(display.sections[0].context).toEqual([block({ included: true })]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ included: false }) });
        expect(display.sections[0].context).toEqual([block({ included: false })]);
    });

    it('invents no verdict for a block id the tree has never held', () => {
        // The carry-over is per id, read from the slot it would replace. A first-seen id has nothing
        // to preserve, and `undefined` is the contract's spelling of "this producer said nothing"
        // (../shared/turn-display.ts `ContextBlock.included`) — never a value this reducer invents.
        const display = displayOf([section({ context: [block({ included: false })] })]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ id: '0-tool-12' }) });

        expect(display.sections[0].context).toEqual([block({ included: false }), block({ id: '0-tool-12' })]);
        expect(display.sections[0].context?.[1].included).toBeUndefined();
    });

    it('drops when the frame names a section this client never adopted', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:7', block: block() })).toBe(false);
        expect(display.sections[0].context).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// context:set — patch what is named, leave the rest, never accumulate
// ---------------------------------------------------------------------------

describe('context:set', () => {
    it('keeps a withheld thinking window withheld while a later patch grows its count', () => {
        // THE PATCH THAT MOVES `chars` MUST NOT MOVE THE VERDICT. A `reasoning` block's `included: false`
        // is the THINKING axis (../shared/turn-display.ts `ContextBlock.included`), and the frame that
        // closes the window — `context:set { chars, eventTo, endedAt }` — names no inclusion field at
        // all. This is the same drop FIX E closed on the `context:add` path, one op later in the stream:
        // a count-only patch that silently cleared the verdict would un-dim a window the trimmer (or the
        // reader) had just switched off, with nothing on screen left to switch.
        const window = block({
            kind: 'reasoning',
            id: '0-thinking',
            name: undefined,
            state: undefined,
            chars: 40,
            argsChars: undefined,
            resultChars: undefined,
            eventTo: undefined,
            endedAt: undefined,
            included: false
        });
        const display = displayOf([section({ context: [window] })]);

        expect(
            apply(display, {
                op: 'context:set',
                turnId: 't1',
                sectionId: 't1:0',
                blockId: '0-thinking',
                patch: { chars: 96, eventTo: 12, endedAt: T + 900 } satisfies ContextBlockPatch
            })
        ).toBe(true);

        expect(display.sections[0].context).toEqual([
            block({
                kind: 'reasoning',
                id: '0-thinking',
                name: undefined,
                state: undefined,
                chars: 96,
                argsChars: undefined,
                resultChars: undefined,
                eventTo: 12,
                endedAt: T + 900,
                included: false
            })
        ]);
    });

    it('applies every patchable field and nothing else', () => {
        const display = displayOf([section({ context: [block()] })]);

        apply(display, {
            op: 'context:set',
            turnId: 't1',
            sectionId: 't1:0',
            blockId: '0-tool-7',
            patch: { name: 'read_file', state: 'error', chars: 90, argsChars: 30, resultChars: 60, inPrompt: false, included: false, at: T + 10, endedAt: T + 910, eventTo: 12 }
        });

        expect(display.sections[0].context).toEqual([
            block({ name: 'read_file', state: 'error', chars: 90, argsChars: 30, resultChars: 60, inPrompt: false, included: false, at: T + 10, endedAt: T + 910, eventTo: 12 })
        ]);
    });

    it('applies `included` as a live verdict, and never guesses one (R7)', () => {
        // The field this patch key EXISTS for: a reader excluding a block from the segment dialog,
        // or a plugin writing `turn.before setIncluded`, mutates a segment that is already on
        // screen. The bar's dim state (R7) reads exactly this value, so the reducer has to move it
        // and NOTHING else — no default, no derivation, no re-mint.
        const display = displayOf([section({ context: [block()] })]);

        expect(apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { included: false } })).toBe(true);
        expect(display.sections[0].context).toEqual([block({ included: false })]);

        // A patch naming NO `included` leaves the verdict alone: that is the wire's "this frame said
        // nothing about inclusion" (../shared/harness-stream.ts:197 — "a key the patch omits is
        // unchanged"), and it is what every other live frame of the same turn sends.
        apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { chars: 90 } });
        expect(display.sections[0].context).toEqual([block({ included: false, chars: 90 })]);

        // `true` is the reader including the block again — the dim comes back off, and the value
        // stays PUBLISHED (the dialog has something to offer because the server named the axis).
        apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { included: true } });
        expect(display.sections[0].context).toEqual([block({ included: true, chars: 90 })]);

        // THE WIRE FORM of "no verdict": `JSON.stringify` drops an `undefined` key, so a producer
        // that cannot name the entry ships a patch WITHOUT the key. The `!== undefined` guard is
        // what keeps that frame from silently switching the block OFF.
        const wirePatch = JSON.parse(JSON.stringify({ chars: 42, included: undefined })) as ContextBlockPatch;

        expect(Object.keys(wirePatch).sort()).toEqual(['chars']);
        apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: wirePatch });
        expect(display.sections[0].context).toEqual([block({ included: true, chars: 42 })]);

        // And a block the server never stamped stays WITHOUT the key: absent is "unknown", and a
        // reducer that defaulted it to `true` would hand every segment a verdict nothing wrote.
        const unnamed = displayOf([section({ context: [block()] })]);

        apply(unnamed, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { state: 'error' } });
        expect(unnamed.sections[0].context?.[0]).not.toHaveProperty('included');
        expect(unnamed.sections[0].context).toEqual([block({ state: 'error' })]);

        // A patch for a block this client never adopted is still a miss, `included` or not.
        expect(apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: 'nope', patch: { included: false } })).toBe(false);
    });

    it('treats every figure as a full replacement, never a delta', () => {
        const display = displayOf([section({ context: [block({ chars: 20, resultChars: undefined, state: 'running' })] })]);

        apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { chars: 80 } });
        apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { chars: 80 } });

        expect(display.sections[0].context?.[0].chars).toBe(80);
        // A field the patch does not name is untouched.
        expect(display.sections[0].context?.[0].state).toBe('running');
        expect(display.sections[0].context?.[0].argsChars).toBe(20);
    });

    it('carries a measured durationMs the projector stamps beside the stamps', () => {
        const display = displayOf([section({ context: [block({ at: T, endedAt: T + 800 })] })]);

        apply(display, {
            op: 'context:set',
            turnId: 't1',
            sectionId: 't1:0',
            blockId: '0-tool-7',
            // Read structurally: the shared type gains this field with the projector, and the
            // reducer must be correct on both sides of that change.
            patch: { durationMs: 790 } as never
        });

        expect((display.sections[0].context?.[0] as ContextBlock & { durationMs?: number }).durationMs).toBe(790);
    });

    it('refuses a block or a section it cannot address', () => {
        const display = displayOf([section({ context: [block()] })]);

        expect(apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: 'nope', patch: { chars: 1 } })).toBe(false);
        expect(apply(display, { op: 'context:set', turnId: 't1', sectionId: 't1:9', blockId: '0-tool-7', patch: { chars: 1 } })).toBe(false);
        expect(display.sections[0].context?.[0].chars).toBe(1204);

        // A section whose context is ABSENT has no block to patch: "not found", and the
        // terminal `view` frame is the documented reconciler.
        const legacy = displayOf([section()]);
        expect(apply(legacy, { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { chars: 1 } })).toBe(false);
    });

    it('never rewrites an identity field', () => {
        const display = displayOf([section({ context: [block()] })]);

        apply(display, {
            op: 'context:set',
            turnId: 't1',
            sectionId: 't1:0',
            blockId: '0-tool-7',
            patch: { id: 'other', kind: 'assistant', turnId: 't9', sectionId: 't1:5', eventFrom: 99 } as never
        });

        expect(display.sections[0].context?.[0]).toEqual(block());
    });
});

// ---------------------------------------------------------------------------
// context:remove / section:remove
// ---------------------------------------------------------------------------

describe('context:remove', () => {
    it('detaches exactly the named segment and keeps the order of the rest', () => {
        const display = displayOf([section({ context: [block({ id: 'a' }), block({ id: 'b' }), block({ id: 'c' })] })]);

        expect(apply(display, { op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: 'b' })).toBe(true);
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['a', 'c']);

        // An id the bar never minted (a duplicate delivery, or a block discarded with a
        // failed attempt) is a no-op that reports itself.
        expect(apply(display, { op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: 'b' })).toBe(false);
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['a', 'c']);
    });

    it('takes the whole bar with a section the server discards', () => {
        const display = displayOf([section({ context: [block()] }), section({ id: 't1:1', context: [block({ id: '1-tool-2', sectionId: 't1:1' })] })]);

        expect(apply(display, { op: 'section:remove', turnId: 't1', sectionId: 't1:1' })).toBe(true);
        expect(display.sections.map((entry) => entry.id)).toEqual(['t1:0']);
        expect(display.sections[0].context?.map((entry) => entry.id)).toEqual(['0-tool-7']);
    });

    it('reports a section that never received a bar as not found', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// A live round trip, and the node patch that keeps the counts exact
// ---------------------------------------------------------------------------

describe('a running call, end to end', () => {
    it('opens as running, settles once, and its figures replace wholesale', () => {
        const display = displayOf([section({ context: [] })]);
        const ops: TurnDisplayOp[] = [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ state: 'running', chars: 20, argsChars: 20, resultChars: undefined, endedAt: undefined, eventTo: 7 }) },
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { chars: 34 } },
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { state: 'ok', chars: 1204, resultChars: 1184, endedAt: T + 800, eventTo: 9 } }
        ];

        for (const op of ops) expect(apply(display, op)).toBe(true);

        expect(display.sections[0].context).toEqual([block()]);
    });
});

describe('node:set chars and redacted', () => {
    const nodeOf = (node: DisplayNode): TurnDisplay => displayOf([section({ nodes: [node], answerNodeId: node.id })]);

    it('stamps the exact character count on a prose node whose text stopped moving', () => {
        const display = nodeOf({ kind: 'text', id: '5', text: 'a bounded preview', committed: true, chars: 320, redacted: true } as DisplayNode);

        expect(apply(display, { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: '5', patch: { chars: 18_402 } })).toBe(true);

        const node = display.sections[0].nodes[0] as Extract<DisplayNode, { kind: 'text' }>;
        expect(node.chars).toBe(18_402);
        // `redacted` is not implied by a growing count: it arrives in its own patch.
        expect(node.redacted).toBe(true);
        expect(node.text).toBe('a bounded preview');
    });

    it('stamps a reasoning node so the think chip can print the server figure', () => {
        const display = nodeOf({ kind: 'reasoning', id: '3', text: 'thinking preview', share: 0.4, chars: 320 } as DisplayNode);

        apply(display, { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: '3', patch: { chars: 4_010, redacted: true, share: 0.8 } });

        const node = display.sections[0].nodes[0] as Extract<DisplayNode, { kind: 'reasoning' }>;
        expect(node).toEqual({ kind: 'reasoning', id: '3', text: 'thinking preview', share: 0.8, chars: 4_010, redacted: true });
    });

    it('leaves a notice and a step untouched by a figure they do not carry', () => {
        const notice = nodeOf({ kind: 'notice', id: 'n1', tone: 'retry', text: 'retrying', at: T } as DisplayNode);
        apply(notice, { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'n1', patch: { chars: 10, redacted: true } });
        expect(notice.sections[0].nodes[0]).toEqual({ kind: 'notice', id: 'n1', tone: 'retry', text: 'retrying', at: T });

        const step = nodeOf({
            kind: 'tool',
            id: '7',
            turnId: 't1',
            sectionId: 't1:0',
            name: 'read',
            argsPreview: 'x',
            state: 'running',
            detail: { stepId: '7', hasResult: false, truncated: true }
        } as DisplayNode);
        apply(step, { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: '7', patch: { chars: 10 } });
        expect((step.sections[0].nodes[0] as { chars?: number }).chars).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Activity is unchanged by a bar frame
// ---------------------------------------------------------------------------

describe('activity and the bar', () => {
    it('does not start or stop a ring for a segment that only reported metadata', () => {
        const view = {
            id: 's1',
            harness: 'instruct',
            status: 'running',
            model: 'm1',
            createdAt: 1,
            updatedAt: T,
            turns: [{ id: 't1', index: 0, prompt: 'go', status: 'running', state: 'streaming', updatedAt: T, sectionCount: 1, stepCount: 1, activeAgents: ['instruct'], blocks: [] }],
            displays: { t1: { turnId: 't1', sections: [section({ context: [block()] })] } }
        } as never;

        const active = new Set<string>(['instruct']);
        applyOpsToActivity(active, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ id: 'new' }) },
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { chars: 10 } },
            { op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: 'new' }
        ]);

        expect([...active]).toEqual(['instruct']);
    });
});

// ---------------------------------------------------------------------------
// The ONE current tail block (T23, R23)
// ---------------------------------------------------------------------------

describe('tail:set', () => {
    const callTail = {
        kind: 'tool',
        nodeId: '7',
        blockId: '0-tool-7',
        chars: 1204,
        truncated: false,
        args: '{"path":"notes.md"}',
        result: 'the whole recorded file body'
    } as const;

    it('replaces the WHOLE descriptor, so no payload survives from the block before it', () => {
        const display = displayOf([section({ tail: callTail })]);

        // A prose designation carries no `args`/`result` at all. Applying a replacement by
        // merge would keep the call's payload printed under a thinking window, which is the
        // exact compactness rule R23 exists to hold.
        expect(
            apply(display, {
                op: 'tail:set',
                turnId: 't1',
                sectionId: 't1:0',
                tail: { kind: 'reasoning', nodeId: 'n3', blockId: '0-reasoning-3', chars: 1_234, truncated: false }
            })
        ).toBe(true);
        expect(display.sections[0].tail).toEqual({
            kind: 'reasoning',
            nodeId: 'n3',
            blockId: '0-reasoning-3',
            chars: 1234,
            truncated: false
        });
    });

    it('applies the tool payload verbatim, including a bounded one', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail })).toBe(true);
        expect(display.sections[0].tail).toEqual({ ...callTail });

        // The cap is the server's statement, never a local length comparison.
        apply(display, { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: { ...callTail, truncated: true } });
        expect(display.sections[0].tail?.truncated).toBe(true);
    });

    it('drops a frame for a section this client never adopted', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'tail:set', turnId: 't1', sectionId: 't1:9', tail: callTail })).toBe(false);
        expect(display.sections[0].tail).toBeUndefined();
    });

    it('leaves every other field of the section alone', () => {
        const display = displayOf([section({ answerNodeId: 'n1', context: [block()] })]);

        apply(display, { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail });

        expect(display.sections[0].answerNodeId).toBe('n1');
        expect(display.sections[0].context).toEqual([block()]);
    });
});

describe('tail:clear', () => {
    const tail = { kind: 'reasoning', nodeId: 'n3', chars: 12, truncated: false } as const;

    it('withdraws the designation the server withdrew', () => {
        const display = displayOf([section({ tail })]);

        expect(apply(display, { op: 'tail:clear', turnId: 't1', sectionId: 't1:0' })).toBe(true);
        expect(display.sections[0].tail).toBeUndefined();
    });

    it('is idempotent, and still the answer for a section that never had one', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'tail:clear', turnId: 't1', sectionId: 't1:0' })).toBe(true);
        expect(apply(display, { op: 'tail:clear', turnId: 't1', sectionId: 't1:0' })).toBe(true);
        expect(apply(display, { op: 'tail:clear', turnId: 't1', sectionId: 't1:9' })).toBe(false);
    });

    it('is distinct from a document that never named a tail (R23)', () => {
        // Absent means "this producer said nothing"; `tail:clear` means "this section has no
        // block to display". A renderer must be able to tell them apart, so the field has to
        // go rather than become an own-key holding undefined.
        const display = displayOf([section({ tail })]);

        apply(display, { op: 'tail:clear', turnId: 't1', sectionId: 't1:0' });

        expect(Object.prototype.hasOwnProperty.call(display.sections[0], 'tail')).toBe(false);
    });
});

describe('node:set unredacted (T23, R23)', () => {
    const boundedThink = (): DisplayNode =>
        ({ kind: 'reasoning', id: 'n1', text: 'a 320-character preview', chars: 900, redacted: true }) as DisplayNode;

    it('restores the whole text the server re-designated, marker withdrawn', () => {
        const display = displayOf([section({ nodes: [boundedThink()] })]);

        expect(
            apply(display, {
                op: 'node:set',
                turnId: 't1',
                sectionId: 't1:0',
                nodeId: 'n1',
                patch: { text: 'the whole recorded thinking window, every character', chars: 45, unredacted: true }
            })
        ).toBe(true);

        // Byte-equal to what the cold document carries for the same designated node: a live
        // tree may not keep a preview the server no longer sends.
        expect(display.sections[0].nodes[0]).toEqual({
            kind: 'reasoning',
            id: 'n1',
            text: 'the whole recorded thinking window, every character',
            chars: 45
        });
    });

    it('leaves an unmarked node untouched when no restore is claimed', () => {
        const display = displayOf([section({ nodes: [boundedThink()] })]);

        apply(display, { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'n1', patch: { chars: 901 } });

        expect(display.sections[0].nodes[0]).toMatchObject({ redacted: true, chars: 901 });
    });

    it('does not touch a notice line, which has no redaction state', () => {
        const notice = { kind: 'notice', id: 'pending', tone: 'info', text: 'pending · read 1.2s' } as DisplayNode;
        const display = displayOf([section({ nodes: [notice] })]);

        apply(display, { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'pending', patch: { text: 'pending · read 2s' } });

        expect(display.sections[0].nodes[0]).toEqual({ kind: 'notice', id: 'pending', tone: 'info', text: 'pending · read 2s' });
    });
});

// ---------------------------------------------------------------------------
// node:insert ownership (T23, R23)
// ---------------------------------------------------------------------------
//
// One ops frame is read by TWO consumers in the same tick: this reducer mutates the cached
// display, and `TurnBoard.applyViewOps` replays the identical array against the DOM. A node the
// document adopts therefore has to be the DOCUMENT'S copy. Before R23 the alias was invisible,
// because a prose node arrived whole inside its `node:insert`. A tail frame streams instead -
// `node:insert {text:''}` then `node:append {delta}` - and on a shared object the append rewrote
// the insert the tile had not read yet: the tile painted the answer from the insert AND again
// from the append, so one streamed answer printed twice. `ui/turns-tail-server.test.ts` observes
// that in the DOM; these two pins are the state half of the same rule.
describe('node:insert ownership (T23, R23)', () => {
    const streamedAnswer = (): DisplayNode =>
        ({ kind: 'text', id: 'n6', text: '', committed: false, chars: 0 }) as DisplayNode;

    it('advances its own copy and leaves the op payload the tile still reads untouched', () => {
        const payload = streamedAnswer();
        const display = displayOf([section({ nodes: [] })]);

        expect(apply(display, { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: payload })).toBe(true);
        expect(
            apply(display, { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n6', delta: 'the streamed answer' })
        ).toBe(true);

        // The document holds the whole delta, with `chars` converged to the bytes the server sent
        // (an un-redacted node's text IS its complete recorded text - turn-display.ts).
        expect(display.sections[0].nodes[0]).toEqual({
            kind: 'text',
            id: 'n6',
            text: 'the streamed answer',
            committed: false,
            chars: 19
        });

        // And the frame it was fed is exactly what arrived, so the tile reaches `node:insert`
        // with an empty node and adds the delta once.
        expect(payload).toEqual({ kind: 'text', id: 'n6', text: '', committed: false, chars: 0 });
        expect(display.sections[0].nodes[0]).not.toBe(payload);
    });

    it('inserts at the index the server named, from its own copy, and stays idempotent on a replay', () => {
        const first = { kind: 'text', id: 'n1', text: 'one', committed: true, chars: 3 } as DisplayNode;
        const display = displayOf([section({ nodes: [first] })]);

        // An out-of-order recovery insert (`index: 0`) places the node BEFORE the existing one.
        const late = { kind: 'reasoning', id: 'n0', text: 'zero', chars: 4 } as DisplayNode;

        expect(apply(display, { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: late, index: 0 })).toBe(true);
        expect(display.sections[0].nodes.map((node) => node.id)).toEqual(['n0', 'n1']);
        expect(display.sections[0].nodes[0]).toEqual({ kind: 'reasoning', id: 'n0', text: 'zero', chars: 4 });
        expect(display.sections[0].nodes[0]).not.toBe(late);

        // The same insert delivered again (a reconnect replaying a frame) must not mint a second
        // node and must not hand back the replayed payload over the advanced one.
        const replay = { kind: 'reasoning', id: 'n0', text: '', chars: 0 } as DisplayNode;

        expect(apply(display, { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: replay })).toBe(true);
        expect(display.sections[0].nodes.map((node) => node.id)).toEqual(['n0', 'n1']);
        expect(display.sections[0].nodes[0]).toEqual({ kind: 'reasoning', id: 'n0', text: 'zero', chars: 4 });
    });
});

// ---------------------------------------------------------------------------
// The lane (C2): which stacked ROW of the one bar a segment belongs to
// ---------------------------------------------------------------------------
//
// `../shared/turn-display.ts:474-491` states the rule the reducer has to honour: the
// projector stamps `lane` when it mints a block and NEVER rewrites it, so the state half has
// exactly two obligations — carry the published value through an add, and make sure no patch
// can move it. `ContextBlockPatch` declares no `lane`, and `contextBlockLaneOf`
// (./view-context.ts) reads an absent lane as 0, so a lost lane is a silently flattened bar:
// a compaction stops being two rows and nothing else in the pipeline notices.
describe('the lane a block was minted with', () => {
    it('carries a published lane through an add, verbatim', () => {
        const display = displayOf([section()]);

        expect(apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ lane: 1 }) })).toBe(true);

        // Exact and complete: the stored record is the delivered one, lane included.
        expect(display.sections[0].context).toEqual([block({ lane: 1 })]);
        expect(display.sections[0].context?.[0].lane).toBe(1);
    });

    it('treats lane 0 as a published value, not as an absence', () => {
        // The projector says `lane: 0` for everything before the first compaction. A reducer
        // that dropped falsy values would make the FIRST row indistinguishable from "no lane
        // data", and `contextBarShowsLaneTagsOf` would stop labelling a bar that starts at a
        // higher lane (./view-context.ts `contextBarShowsLaneTagsOf`).
        const display = displayOf([section()]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ lane: 0 }) });

        expect(display.sections[0].context?.[0].lane).toBe(0);
        expect('lane' in (display.sections[0].context?.[0] as ContextBlock)).toBe(true);
    });

    it('mints no lane for a record that never published one', () => {
        // The other direction matters just as much: synthesizing `lane: 0` here would turn
        // every legacy frame into an explicitly-first-row record, and a bar of mixed
        // lane-less and lane-1 blocks would order by insertion instead of by lane.
        const display = displayOf([section()]);

        apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() });

        expect('lane' in (display.sections[0].context?.[0] as ContextBlock)).toBe(false);
        expect(display.sections[0].context).toEqual([block()]);
    });

    it('never lets a patch move a lane, whatever a stale producer sends', () => {
        const display = displayOf([section({ context: [block({ lane: 2 })] })]);

        apply(display, {
            op: 'context:set',
            turnId: 't1',
            sectionId: 't1:0',
            blockId: '0-tool-7',
            // Read structurally: `lane` is NOT in `ContextBlockPatch`, so a producer that
            // patches one anyway is out of contract and the reducer must ignore it.
            patch: { chars: 80, lane: 5 } as never
        });

        // The patched figure landed, the identity-shaped figure did not.
        expect(display.sections[0].context?.[0].chars).toBe(80);
        expect(display.sections[0].context?.[0].lane).toBe(2);
    });

    it('moves the lane only when a whole record replaces it', () => {
        // A re-delivered `context:add` REPLACES the stored record (the reconnect path), which
        // is the one documented way a lane changes: the new whole record states it.
        const display = displayOf([section({ context: [block({ lane: 0 })] })]);

        expect(apply(display, { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ lane: 1 }) })).toBe(true);

        expect(display.sections[0].context).toEqual([block({ lane: 1 })]);
        expect(display.sections[0].context).toHaveLength(1);
    });
});
