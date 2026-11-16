// T23/C1 — the cheap change stamp of one compiled display tree.
//
// `ui/turns.ts` `syncCompiledDisplay` (:8321) skips its whole node-level pass when the tree
// an applied document carries is the tree the tile is already painted from, so the stamp it
// uses must satisfy one contract in both directions:
//
//   unchanged content  ⇒ SAME stamp   (the skip fires: no Markdown re-parse, selection kept)
//   any change         ⇒ DIFFERENT stamp (an in-place op mutation must never be frozen)
//
// V1 used `JSON.stringify(display)` — byte-exact, but proportional to the tree's SIZE, and
// it ran per painted tile per applied document (every stream frame, every 1 s poll tick).
// `displayStampOf` keeps the same exhaustive structural walk and bounds only LONG strings
// (length + head/tail sample), so the whole point of this file is: for every mutation the
// ops fold actually performs, the new stamp changes exactly when the old signature did.
//
// The pinned DOM-level half of this contract lives in ./turns-compiled.test.ts:1089 (skip
// fires for an unchanged tree, re-parse fires for an in-place mutation and for a fresh tree);
// this file pins the stamp itself, which that test cannot inspect.
//
// Run: yarn vitest run src/frontend/ui/display-stamp.test.ts

import { describe, expect, it } from 'vitest';
import type { ContextBlock, DisplayNode, TurnDisplay, TurnSection } from '../../shared/turn-display';
import { displayStampOf } from './display-stamp';

// The stamp V1 used, spelled out here so the equivalence is stated against the REAL old
// behaviour rather than a paraphrase of it.
const oldSignatureOf = (display: TurnDisplay): string => JSON.stringify(display);

// A tree with the shape the projector really produces: prose that streams (one long body,
// one superseded preview), a tool step carrying payloads, a reasoning window, a context bar
// with the reader's inclusion verdict, and a designated tail. `revision` is the wire's
// counter, now passed through by ../display-project.ts:444.
const contextBlock = (over: Partial<ContextBlock> = {}): ContextBlock => ({
    id: 'b1',
    kind: 'tool',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'read',
    chars: 4096,
    argsChars: 64,
    resultChars: 4032,
    inPrompt: true,
    included: true,
    eventFrom: 4,
    eventTo: 9,
    state: 'done',
    ...over
});

const treeOf = (): TurnDisplay =>
    ({
        turnId: 't1',
        revision: 7,
        sections: [
            {
                id: 't1:0',
                role: 'agent',
                agent: 'writer',
                agentLabel: 'WR1',
                state: 'streaming',
                latestInput: 1200,
                cachedInput: 900,
                answerNodeId: 'n1',
                nodes: [
                    { kind: 'text', id: 'n0', text: 'earlier **answer** body kept whole', committed: true, chars: 34 },
                    {
                        kind: 'reasoning',
                        id: 'n1',
                        text: 'thinking window preview',
                        chars: 512,
                        redacted: true,
                        share: 0.25
                    },
                    {
                        kind: 'tool',
                        id: 'n2',
                        turnId: 't1',
                        sectionId: 't1:0',
                        name: 'read',
                        state: 'running',
                        argsPreview: '{"path":"src/frontend/main.ts"}',
                        preview: 'read src/frontend/main.ts',
                        detail: { stepId: '4', hasResult: false, truncated: false },
                        pending: [{ id: 'c1', name: 'read', argsPreview: '{"path"' }]
                    },
                    { kind: 'notice', id: 'n3', tone: 'info', text: 'pending · read 1.2s', at: 1700000000000 }
                ] as DisplayNode[],
                context: [contextBlock(), contextBlock({ id: 'b2', kind: 'reasoning', name: 'thinking', chars: 512 })],
                tail: { kind: 'tool', nodeId: 'n2', blockId: 'b1', args: '{"path":"src/frontend/main.ts"}', result: '' }
            }
        ] as TurnSection[],
        lastSectionOrdinal: 0
    }) as TurnDisplay;

// The mutation set the ops fold performs, each applied to a live tree IN PLACE (the exact
// shape ./main.ts:13832 and the 1 s poll carry hand to the tile):
//   - `node:append` (../view-state.ts:443)   `node.text += delta`
//   - `node:insert` (:333/:338)              `nodes.push(node)`
//   - `node:set` (:462-495)                  flag flips: `committed`, `redacted`, `share`
//   - `context:set` (:637-668)               `included`, `state`, `chars`
//   - `section:set` (:411)                   `state`
//   - `step:set` (:538)                      the whole step object, payloads included
// plus the two object-level cases the renderer sees: a fresh tree whose content is identical
// (a re-read that changed nothing) and a fresh tree whose content moved (the re-read path
// ./view-shell.ts `ensureVisible` installs).
type Mutation = { label: string; apply: (display: TurnDisplay) => void };

const mutations: Mutation[] = [
    {
        label: 'a streamed delta appended in place (view-state.ts:443)',
        apply: (display) => {
            const node = display.sections[0].nodes[0];
            if (node.kind !== 'text') throw new Error('fixture drifted');
            node.text += ' and more prose';
        }
    },
    {
        label: 'a new node pushed in place (view-state.ts:338)',
        apply: (display) => {
            display.sections[0].nodes.push({ kind: 'notice', id: 'n9', tone: 'info', text: 'retry 1 of 2' });
        }
    },
    {
        label: 'a `committed` flag flipped in place (view-state.ts:462)',
        apply: (display) => {
            const node = display.sections[0].nodes[0];
            if (node.kind !== 'text') throw new Error('fixture drifted');
            node.committed = false;
        }
    },
    {
        label: 'a `redacted` marker added in place (view-state.ts:494)',
        apply: (display) => {
            const node = display.sections[0].nodes[1];
            if (node.kind !== 'reasoning') throw new Error('fixture drifted');
            node.redacted = true;
            node.text = 'a bounded preview replaces the whole body here';
            node.chars = 900;
        }
    },
    {
        label: 'a `context:set` inclusion verdict flipped (view-state.ts:657)',
        apply: (display) => {
            const block = display.sections[0].context?.[0];
            if (block === undefined) throw new Error('fixture drifted');
            block.included = false;
        }
    },
    {
        label: 'a `context:set` count moved (view-state.ts:647)',
        apply: (display) => {
            const block = display.sections[0].context?.[1];
            if (block === undefined) throw new Error('fixture drifted');
            block.chars = 900;
        }
    },
    {
        label: 'a section `state` flipped (view-state.ts:411)',
        apply: (display) => {
            display.sections[0].state = 'done';
        }
    },
    {
        label: 'a settled step replacing its object (view-state.ts:538)',
        apply: (display) => {
            const nodes = display.sections[0].nodes;
            nodes[2] = {
                ...(nodes[2] as Extract<DisplayNode, { kind: 'tool' }>),
                state: 'done',
                outcome: 'ok',
                durationMs: 1200,
                endedAt: 1700000001200,
                detail: { stepId: '4', resultStepId: '9', hasResult: true, truncated: true },
                pending: []
            };
        }
    },
    {
        label: 'a notice line rewritten with the SAME length (view-state.ts:478)',
        apply: (display) => {
            const node = display.sections[0].nodes[3];
            if (node.kind !== 'notice') throw new Error('fixture drifted');
            node.text = 'pending · read 1.8s';
        }
    }
];

describe('the compiled display change stamp (T23/C1)', () => {
    it('changes exactly when the V1 JSON.stringify signature changed, for every fold mutation', () => {
        const baseline = treeOf();
        const oldBaseline = oldSignatureOf(baseline);
        const newBaseline = displayStampOf(baseline);

        // A deterministic re-read of the SAME content: both representations agree that
        // nothing moved, which is what lets the skip fire for an unchanged tree.
        expect(displayStampOf(treeOf())).toBe(newBaseline);
        expect(oldSignatureOf(treeOf())).toBe(oldBaseline);

        for (const mutation of mutations) {
            const next = treeOf();

            mutation.apply(next);

            const oldChanged = oldSignatureOf(next) !== oldBaseline;
            const newChanged = displayStampOf(next) !== newBaseline;

            // Both directions of the gate contract, per mutation: the signature is the
            // reference behaviour, so a divergence in EITHER direction is a regression.
            expect({ label: mutation.label, oldChanged, newChanged }).toEqual({
                label: mutation.label,
                oldChanged: true,
                newChanged: true
            });
        }
    });

    it('does not change for a no-op or for a fresh tree with identical content', () => {
        const baseline = treeOf();
        const stamp = displayStampOf(baseline);

        // A poll tick re-applying the untouched tree: the skip must fire.
        expect({ old: oldSignatureOf(baseline) === oldSignatureOf(treeOf()), new: displayStampOf(baseline) === stamp }).toEqual(
            { old: true, new: true }
        );

        // A re-read that carries the same content in new objects: also a skip, for both.
        const cloned = JSON.parse(JSON.stringify(baseline)) as TurnDisplay;

        expect({
            old: oldSignatureOf(cloned) === oldSignatureOf(baseline),
            new: displayStampOf(cloned) === stamp
        }).toEqual({ old: true, new: true });
    });

    it('changes for a fresh tree whose content moved, and for a fresh revision of an identical tree', () => {
        const baseline = treeOf();
        const stamp = displayStampOf(baseline);

        // ./turns-compiled.test.ts:1136 phase 3 — a fresh object holding DIFFERENT text must
        // re-parse. The old signature saw the new bytes; so does the stamp.
        const fresh = treeOf();
        const node = fresh.sections[0].nodes[0];
        if (node.kind !== 'text') throw new Error('fixture drifted');
        node.text = 'a **different** answer';

        expect({
            old: oldSignatureOf(fresh) !== oldSignatureOf(baseline),
            new: displayStampOf(fresh) !== stamp
        }).toEqual({ old: true, new: true });

        // The part `revision` buys (../display-project.ts:444 now carries the wire counter):
        // a read that restamps an otherwise identical tree repaints deterministically, even
        // in the one case the bounded sample could not see on its own.
        const restamped = { ...JSON.parse(JSON.stringify(baseline)), revision: 8 } as TurnDisplay;

        expect({
            old: oldSignatureOf(restamped) !== oldSignatureOf(baseline),
            new: displayStampOf(restamped) !== stamp
        }).toEqual({ old: true, new: true });
    });

    it('keeps the documented boundary: a same-length middle edit of one SAMPLED body is the only miss', () => {
        // `SHORT_STRING_CHARS` (./display-stamp.ts) is the verbatim band; above it a body
        // contributes `length + head + tail`. Two bodies with the same length, head and tail
        // and a different middle therefore stamp identically while the byte-exact signature
        // differs. The stream contract never sends that mutation — prose moves by append, by
        // wholesale replacement, or by redaction, and every applied document restamps
        // `revision` — and the server's own designation stamp makes the same deliberate trade
        // (../server/turn-projector.ts:1834 `tailStampOf`). Pinned so the trade is stated
        // rather than hidden, together with the case the stream DOES send.
        const longBody = (middle: string): string => `${'A'.repeat(60)}${middle}${'Z'.repeat(60)}`;

        const baseline = treeOf();
        const node = baseline.sections[0].nodes[0];
        if (node.kind !== 'text') throw new Error('fixture drifted');
        node.text = longBody('one');

        const edited = JSON.parse(JSON.stringify(baseline)) as TurnDisplay;
        const editedNode = edited.sections[0].nodes[0];
        if (editedNode.kind !== 'text') throw new Error('fixture drifted');
        editedNode.text = longBody('two');

        expect({
            sameLength: longBody('one').length === longBody('two').length,
            old: oldSignatureOf(edited) !== oldSignatureOf(baseline),
            new: displayStampOf(edited) === displayStampOf(baseline)
        }).toEqual({ sameLength: true, old: true, new: true });

        // A streamed body growing: the append moves the length AND the sampled tail, so the
        // bound never freezes an actively streaming tile.
        const appended = JSON.parse(JSON.stringify(baseline)) as TurnDisplay;
        const appendedNode = appended.sections[0].nodes[0];
        if (appendedNode.kind !== 'text') throw new Error('fixture drifted');
        appendedNode.text = longBody('one') + ' and the answer keeps streaming';

        expect({
            old: oldSignatureOf(appended) !== oldSignatureOf(baseline),
            new: displayStampOf(appended) !== displayStampOf(baseline)
        }).toEqual({ old: true, new: true });
    });
});
