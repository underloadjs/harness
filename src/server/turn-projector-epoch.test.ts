// T-W8 — the epoch's DURABILITY half (`HarnessThread.epoch`, ./turn-projector.ts).
//
// WHY THIS FILE IS SEPARATE. The fold semantics of the epoch — a KNOWN epoch that differs is
// a run boundary, an absent one decides nothing — are pinned scenario by scenario in
// ./turn-projector-restart.test.ts (its T-W8 group). A discriminator that only lives in the
// live process would be decorative: the split has to survive the trip to disk and back, or a
// reload would paint a different board than the stream did. That trip is what is pinned here:
//
//   1. the durable journal line carries the payload-level epoch verbatim (./journal.ts builds
//      its record from `turnId`/`index`/`at`/`event` and passes `event` through untouched — no
//      line schema changed, and none was needed), and reading it back yields byte-identical
//      frames, epoch included;
//   2. the store's own event copy — `sessions.ts` `copyEvent` is `JSON.parse(JSON.stringify(e))`
//      — keeps the key, so the compiled view a live turn builds is the view a restore rebuilds;
//   3. folding the RESTORED lines mints the same rows as folding the live ones: the
//      post-restart child still gets its own section after a server restart, and the legacy
//      record (no epoch anywhere) still folds into the merged row it folded into before;
//   4. the epoch never rides the WIRE: it is projector row state
//      (`SectionRecord.epoch`), so no `TurnDisplayOp`, no `TurnSection`, and no `TurnSummary`
//      carries the key — which is why ../shared/harness-api.ts and ./harness.swagger.yaml did
//      not move.
//
// Scratch lives in the repo-root Temp/ (root AGENTS.md), never the OS temp dir.
//
// Run: yarn vitest run src/server/turn-projector-epoch.test.ts   (cwd packages/underload/harness)

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplayOp } from '../shared/turn-display';
import { HARNESS_JOURNAL_VERSION, HarnessJournal } from './journal';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

const CONTEXT: DisplayProjectContext = { primary: 'one' };

// The repo-root Temp/ (root AGENTS.md): journal files are throwaway artifacts.
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRATCH_ROOT = path.join(REPO_ROOT, 'Temp', 'orch-plan', 'w8');

fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, `epoch-journal-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const timeOf = (index: number): number => 1_000 + index * 10;

const SETTLE_AT = 5_000;

// Fold one recorded event list the way the store does: push, then `apply`, then `settle`
// (./turn-projector.ts, the one-rule-at-the-top path a live turn and a cold read share).
const foldEvents = (events: HarnessEvent[], stamps: number[] = events.map((_event, index) => timeOf(index))) => {
    const turn: SessionTurn = {
        id: 'turn-1',
        index: 0,
        prompt: 'do the thing',
        status: 'running',
        startedAt: 1_000,
        updatedAt: 1_000,
        events: [],
        eventTimes: []
    };

    const projector = createTurnProjector(turn, CONTEXT);
    const ops: TurnDisplayOp[][] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(stamps[index]);
        ops.push(projector.apply(event, stamps[index], index));
    });

    turn.status = 'done';
    turn.updatedAt = SETTLE_AT;
    projector.settle('done', SETTLE_AT);

    return { turn, ops, display: projector.display(), summary: projector.summary() };
};

const child = (callId: string, epoch?: string): HarnessEvent['thread'] => ({
    id: 'inv-16',
    parentId: 'inv-root',
    callId,
    kind: 'delegation',
    input: 'sub task',
    ...(epoch === undefined ? {} : { epoch })
});

// The F5 residual as the runtime records it: one `delegate` call, then the child's frames
// from process `epochA`, cut off mid-run, then the SAME invocation id and the SAME call id
// from process `epochB`. Both epochs absent is the legacy shape — the record every store
// written before 2026-11-17 holds, and the parity baseline for this file.
const restarted = (epochA?: string, epochB?: string): HarnessEvent[] => [
    { type: 'start', agent: 'one', model: 'gpt-x', thread: { id: 'inv-root' } },
    {
        type: 'tool_call',
        agent: 'one',
        call: { id: 'call-1', name: 'delegate', arguments: JSON.stringify({ agent: 'two', input: 'sub task' }) }
    },
    { type: 'start', agent: 'two', model: 'gpt-y', thread: child('call-1', epochA) },
    { type: 'reasoning', agent: 'two', delta: 'pre-restart lane', thread: child('call-1', epochA) },
    { type: 'start', agent: 'two', model: 'gpt-y', thread: child('call-1', epochB) },
    { type: 'reasoning', agent: 'two', delta: 'post-restart lane', thread: child('call-1', epochB) }
];

const RESTARTED_CHILD = restarted('e1', 'e2');

const nodesOf = (display: ReturnType<typeof foldEvents>['display'], id: string): unknown[] =>
    display.sections.find((section) => section.id === id)?.nodes ?? [];

describe('the epoch survives the trip to disk and back (T-W8)', () => {
    it('writes the epoch into the durable line and reads the identical frame back', () => {
        const journal = new HarnessJournal(tempRoot('round-trip'), 'session-epoch');

        journal.open();
        expect(journal.error).toBeUndefined();

        RESTARTED_CHILD.forEach((event, index) => {
            journal.append({
                turnId: 'turn-1',
                index,
                at: timeOf(index),
                event: JSON.parse(JSON.stringify(event)) as HarnessEvent
            });
        });

        journal.flush();

        const read = journal.read();

        expect(read.problems).toEqual([]);
        expect(read.events).toHaveLength(6);

        // (1)+(2) The epoch is a PAYLOAD-level field, so both durable copies keep it verbatim:
        // the JSONL line (the writer serialises the record whole) and the reader's rebuild
        // (which names only `turnId`/`index`/`at` and passes `event` through). No line schema,
        // no snapshot version, and no journal migration was needed — and none was added.
        const lines = fs
            .readFileSync(journal.file, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0);

        expect(lines).toHaveLength(7); // header + six event records
        expect(lines[3]).toContain('"epoch":"e1"');
        expect(lines[5]).toContain('"epoch":"e2"');

        const restored = read.events.map((entry) => entry.event);

        expect(restored).toEqual(RESTARTED_CHILD);
        expect(restored.map((event) => event.thread?.epoch)).toEqual([undefined, undefined, 'e1', 'e1', 'e2', 'e2']);

        // (3) The RESTORED lines fold to the same board the live stream painted: the
        // post-restart child owns its own row, one run per process, and the answer never
        // lands on a stranger's card.
        const live = foldEvents(RESTARTED_CHILD);
        const replay = foldEvents(restored);

        expect(replay.display).toEqual(live.display);
        expect(replay.summary).toEqual(live.summary);
        expect(replay.display.sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:2']);
        expect(nodesOf(replay.display, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lane', chars: 16 }
        ]);
        expect(nodesOf(replay.display, 'turn-1:2')).toEqual([
            { kind: 'reasoning', id: 'n5', text: 'post-restart lane', chars: 17 }
        ]);

        // A second, independent cold fold of the same restored record (what every later
        // `getView` serves) is byte-identical, so no resync can show a different board.
        const cold = projectTurn(replay.turn, CONTEXT);

        expect(cold.display).toEqual(live.display);
        expect(cold.summary).toEqual(live.summary);
    });

    it('keeps a record that names no epoch byte-identical through the same trip', () => {
        const journal = new HarnessJournal(tempRoot('legacy'), 'session-legacy');

        journal.open();
        expect(journal.error).toBeUndefined();

        restarted().forEach((event, index) => {
            journal.append({
                turnId: 'turn-1',
                index,
                at: timeOf(index),
                event: JSON.parse(JSON.stringify(event)) as HarnessEvent
            });
        });

        journal.flush();

        const read = journal.read();

        expect(read.problems).toEqual([]);

        const restored = read.events.map((entry) => entry.event);

        expect(restored).toEqual(restarted());
        expect(restored.every((event) => event.thread === undefined || !('epoch' in event.thread))).toBe(true);

        // The rows a pre-change store holds — and the rows it will keep holding after this
        // server starts, because a folded view never rewrites the record: ONE child row with
        // both runs' prose in one block, exactly as ./turn-projector-restart.test.ts pins it.
        const replay = foldEvents(restored);

        expect(replay.display.sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);
        expect(nodesOf(replay.display, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lanepost-restart lane', chars: 33 }
        ]);

        const live = foldEvents(restarted());

        expect(replay.display).toEqual(live.display);
        expect(replay.summary).toEqual(live.summary);
    });

    it('never puts the epoch on the wire', () => {
        // The ops a running turn streams, the compiled tree every read serves, and the summary
        // row are the whole display contract. `SectionRecord.epoch` is projector row state, so
        // the key appears in NONE of them — which is why the generated REST contract
        // (../shared/harness-api.ts, ./harness.swagger.yaml) and the browser's `HarnessThread`
        // alias did not have to move.
        const folded = foldEvents(RESTARTED_CHILD);
        const wire = JSON.stringify({
            ops: folded.ops.flatMap((list) => list),
            display: folded.display,
            summary: folded.summary
        });

        expect(wire.includes('epoch')).toBe(false);
        // Not the mint on the wire either: what the wire names is the invocation id the runtime
        // recorded — recycled, and carried by BOTH rows — never the fact that separated them.
        expect(JSON.stringify(folded.display.sections.map((section) => section.invocationId))).toBe(
            JSON.stringify(['inv-root', 'inv-16', 'inv-16'])
        );
        expect(folded.summary).toMatchObject({ status: 'done', state: 'done', sectionCount: 3 });
    });

    it('writes the version-1 journal line unchanged apart from the payload key', async () => {
        // The line format is a published, hand-inspectable contract (./journal.ts). Only the
        // payload gained a key: same header, same field order for the envelope, same version.
        const journal = new HarnessJournal(tempRoot('format'), 'session-format');

        journal.open();

        journal.append({
            turnId: 'turn-1',
            index: 0,
            at: 1_000,
            event: { type: 'start', agent: 'two', model: 'gpt-y', thread: child('call-1', 'e1') } as HarnessEvent
        });

        journal.flush();

        const lines = fs
            .readFileSync(journal.file, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0);

        // The header carries its own `createdAt` (wall clock at open, pinned by
        // ./journal.test.ts), so the envelope is asserted with the two fields this change
        // could have moved: the line kind and the journal VERSION.
        expect(JSON.parse(lines[0])).toMatchObject({
            type: 'header',
            v: HARNESS_JOURNAL_VERSION,
            sessionId: 'session-format'
        });
        expect(JSON.parse(lines[1])).toEqual({
            type: 'event',
            v: HARNESS_JOURNAL_VERSION,
            turnId: 'turn-1',
            index: 0,
            at: 1_000,
            event: {
                type: 'start',
                agent: 'two',
                model: 'gpt-y',
                thread: {
                    id: 'inv-16',
                    parentId: 'inv-root',
                    callId: 'call-1',
                    kind: 'delegation',
                    input: 'sub task',
                    epoch: 'e1'
                }
            }
        });
    });
});
