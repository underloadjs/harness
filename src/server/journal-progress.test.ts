// journal.ts + turn-projector.ts — a journaled `progress` line, replayed (task T2 AC3b).
//
// WHY THIS FILE EXISTS. Every harness event is journalled verbatim
// (./sessions.ts `copyEvent` is a JSON clone, and ./journal.ts writes one JSONL record per
// event), so the new `progress` kind lands on disk whether or not any reader understands
// it. The acceptance rule it has to satisfy:
//
//   REPLAYING A JOURNAL THAT CONTAINS progress lines yields the SAME transcript and the
//   SAME display as one that does not — plus unknown-reader tolerance.
//
// Pinned here, in the order the durable path actually walks:
//   1. ONE LINE, VERBATIM, COUNTERS ONLY — the frame round-trips through the file exactly,
//      and the bytes on disk contain no tool argument text (the journal stays small and
//      model-private even for a 6.5k-character block);
//   2. ORDER — a progress line never shifts another event's `index`, so a resume replays
//      the same sequence a live watcher saw, and the step/block ids derived from those
//      indices (./turn-projector.ts `blockIdOf`) cannot move;
//   3. PARITY — two journals of the SAME turn, one with the heartbeat and one without,
//      replay into turns whose projections differ in the ONE `toolProgress` field and
//      nothing else: same nodes, same context bar, same summary, same transcript-bearing
//      surface. A reader that ignores the kind and a reader that paints it therefore agree
//      about everything the transcript is made of.
//
// Run: yarn vitest run src/server/journal-progress.test.ts   (cwd packages/underload/harness)

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../engine/harness';
import type { DisplayProjectContext, TurnDisplay } from '../engine/shared/turn-display';
import { HARNESS_JOURNAL_VERSION, HarnessJournal, journalLine } from './journal';
import type { SessionTurn } from './protocol';
import { projectTurn } from './turn-projector';

// Scratch belongs in the repo-root Temp/ (root AGENTS.md), never the OS temp dir.
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-journal-progress-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const open = (root: string): HarnessJournal => {
    const journal = new HarnessJournal(root, 'session-1');

    journal.open();

    return journal;
};

const CONTEXT: DisplayProjectContext = { entry: 'one' };

const text = (delta: string): HarnessEvent => ({ type: 'text', agent: 'one', delta });

const progress = (toolCallSlots: number, argumentChars: number): HarnessEvent => ({
    type: 'progress',
    agent: 'one',
    phase: 'tool-composition',
    toolCallSlots,
    argumentChars
});

const commit = (): HarnessEvent => ({ type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 11 });

const SECRET_BLOCK = '{"agents":[{"task":"the secret task"},{"task":"b"}]}';

const toolCall = (): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id: 'call_1', name: 'delegate', arguments: SECRET_BLOCK }
});

// Rebuild a `SessionTurn` from a journal read — what ./sessions.ts restore does — so the
// cold projection below is fed the durable bytes, not the in-memory objects.
const turnFrom = (events: HarnessEvent[]): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'launch the batteries',
    status: 'done',
    startedAt: 1_000,
    updatedAt: 5_000,
    events: events.map((event) => JSON.parse(JSON.stringify(event)) as HarnessEvent),
    eventTimes: events.map((_event, index) => 1_000 + index * 10)
});

// The ONE field this feature owns, removed from every section: whatever remains is what a
// reader that never heard of `progress` sees.
const withoutField = (display: TurnDisplay): TurnDisplay =>
    JSON.parse(JSON.stringify(display, (key, value) => (key === 'toolProgress' ? undefined : value))) as TurnDisplay;

// Keys whose VALUE legitimately differs between two journals of the same turn once a
// heartbeat is interleaved: a `progress` line consumes a journal POSITION like every other
// journaled event does (the `wakeup` precedent, ../types/index.ts:4110), and node ids,
// context segments and timestamps are all derived from that position
// (./turn-projector.ts `blockIdOf`). Dropping exactly these — and ONLY these, see the
// second assertion in the parity test — is what lets the comparison stay byte-exact about
// everything the transcript is actually made of.
const POSITION_KEYS = new Set([
    'id',
    'nodeId',
    'blockId',
    'stepId',
    'sectionId',
    'turnId',
    'at',
    'startedAt',
    'endedAt',
    'revision',
    'index',
    'lastSectionOrdinal',
    'answerNodeId',
    'invocationId',
    'threadId',
    'eventFrom',
    'eventTo',
    'toolProgress'
]);

const withoutPosition = (value: unknown): unknown =>
    JSON.parse(
        JSON.stringify(value, (key, child) => (POSITION_KEYS.has(key) ? undefined : child))
    ) as unknown;

describe('a journaled `progress` line', () => {
    it('round-trips verbatim, as counters only, and holds no argument text', () => {
        const journal = open(tempRoot('verbatim'));

        journal.append({ turnId: 't1', index: 0, at: 1_000, event: text('OK. ') });
        journal.append({ turnId: 't1', index: 1, at: 1_001, event: progress(4, 6_512) });
        journal.flush();

        const read = journal.read();

        expect(read.problems).toEqual([]);
        expect(read.events.map((entry) => entry.event)).toEqual([text('OK. '), progress(4, 6_512)]);

        // One JSONL line for the frame, and the line is the exact record — so a tool block
        // of any size costs a fixed number of bytes.
        const lines = fs.readFileSync(journal.file, 'utf8').split('\n').filter((line) => line.length > 0);

        expect(lines).toHaveLength(3);
        expect(lines[2].trimEnd()).toBe(
            journalLine({ type: 'event', v: HARNESS_JOURNAL_VERSION, turnId: 't1', index: 1, at: 1_001, event: progress(4, 6_512) }).trimEnd()
        );

        // Nothing model-private is on disk: the counters are there, the argument TEXT is
        // not, and the journal never grows with the block it is describing.
        expect(lines[2]).toContain('"argumentChars":6512');
        expect(lines[2]).not.toContain('agents');
        expect(lines[2]).not.toContain('task');
    });

    it('never shifts another event index, so a resume replays the same order', () => {
        const journal = open(tempRoot('order'));

        // The order the harness publishes them in (../harness.progress.test.ts): deltas,
        // the heartbeat, then the frames the terminal round produces.
        const sequence: HarnessEvent[] = [text('OK. '), progress(1, 11), progress(4, 6_512), toolCall(), commit()];

        sequence.forEach((event, index) => {
            journal.append({ turnId: 't1', index, at: 1_000 + index, event });
        });

        journal.flush();

        const read = journal.read();

        expect(read.problems).toEqual([]);
        expect(read.events.map((entry) => [entry.index, entry.event.type])).toEqual([
            [0, 'text'],
            [1, 'progress'],
            [2, 'progress'],
            [3, 'tool_call'],
            [4, 'attempt_commit']
        ]);
        expect(read.events.map((entry) => entry.event)).toEqual(sequence);
    });

    it('replays to the SAME projection as a journal without those lines — apart from the field itself', () => {
        // THE parity pin. Two journals of the same turn: one carried the heartbeat, one
        // did not. Restored and folded cold (what a reload and a resync serve), their
        // projections agree on every node, every context segment, every summary field and
        // the whole event transcript — and differ ONLY in `toolProgress`.
        const withHeartbeat = open(tempRoot('parity-with'));

        const withoutHeartbeat = open(tempRoot('parity-without'));

        const both: HarnessEvent[] = [text('OK. '), toolCall(), commit()];

        both.forEach((event, index) => {
            withoutHeartbeat.append({ turnId: 't1', index, at: 1_000 + index, event });
        });

        withoutHeartbeat.flush();

        const interleaved: HarnessEvent[] = [text('OK. '), progress(1, 11), progress(4, 6_512), toolCall(), commit()];

        interleaved.forEach((event, index) => {
            withHeartbeat.append({ turnId: 't1', index, at: 1_000 + index, event });
        });

        withHeartbeat.flush();

        const quietTurn = turnFrom(withoutHeartbeat.read().events.map((entry) => entry.event));
        const noisyTurn = turnFrom(withHeartbeat.read().events.map((entry) => entry.event));

        const quiet = projectTurn(quietTurn, CONTEXT);
        const noisy = projectTurn(noisyTurn, CONTEXT);

        // The transcript-bearing surface: identical in everything the transcript is made
        // of — node kinds and their exact text, context segments and their exact `chars`,
        // the tail designation — once the POSITION-derived keys are set aside (a
        // heartbeat consumes a journal position, exactly like `wakeup` does, and ids and
        // timestamps are derived from that position).
        expect(withoutPosition(noisy.display)).toEqual(withoutPosition(quiet.display));

        // The honest limit of that claim, stated rather than hidden: with their real ids
        // and timestamps the two displays are NOT equal, because a heartbeat occupies
        // journal positions ahead of the tool call. Nothing in the transcript changed; the
        // ordinals moved, exactly as they already move for a journaled `wakeup`.
        expect(withoutField(noisy.display)).not.toEqual(withoutField(quiet.display));

        // Not vacuous: the parts that must agree are compared digit-exact, ids and
        // timestamps included. A node that gained text, a context segment that moved in
        // SIZE, or a call whose arguments changed fails this.
        const surfaceOf = (display: TurnDisplay) =>
            display.sections.map((section) => ({
                kinds: section.nodes.map((node) => node.kind),
                bytes: section.nodes.map((node) => JSON.stringify(node).replace(/\d+/g, '#').length),
                context: (section.context ?? []).map((block) => [block.kind, block.chars]),
                tail: section.tail?.kind
            }));

        expect(surfaceOf(noisy.display)).toEqual(surfaceOf(quiet.display));
        expect(surfaceOf(noisy.display)[0]?.kinds).toEqual(['text', 'tool']);

        // The recorded events differ ONLY by the two heartbeat lines, in position — which
        // is exactly what a resume replays, and what a reader that ignores the kind skips.
        expect(noisyTurn.events.map((event) => event.type)).toEqual([
            'text',
            'progress',
            'progress',
            'tool_call',
            'attempt_commit'
        ]);
        expect(quietTurn.events.map((event) => event.type)).toEqual(['text', 'tool_call', 'attempt_commit']);
        expect(noisyTurn.events.filter((event) => event.type !== 'progress')).toEqual(quietTurn.events);

        // And the field that IS the difference: the heartbeat journal settled it to `idle`
        // at the `attempt_commit` boundary, the quiet one never reported anything at all.
        expect(noisy.display.sections[0]?.toolProgress).toEqual({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 });
        expect(quiet.display.sections[0]?.toolProgress).toBeUndefined();
    });
});
