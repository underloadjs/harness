// W19 (2026-11-17) — THE CLIENT TRANSCRIPT JOIN DISCRIMINATES THE RUN A FRAME BELONGS TO
//
// THE JOIN. `buildThreadTranscriptJson` reconstructs ONE conversation's history from a client
// snapshot: its own turns, plus the invocation events recorded inside turns owned by OTHER
// conversations (a delegated child's frames live in the turn that ran them). To place those foreign
// frames it joins `invocation id -> conversation`, taken from the roster rows (`invocationId` /
// `originInvocationId` / `invocationIds`), first-wins on the bare id.
//
// THE DEFECT. An invocation id is a per-process counter, NOT a unique key
// (`../../shared/run-identity.ts`): a restarted process re-mints ids the previous process already
// used (`runSequence` restarts with the process, `../../harness.ts:8462`, and a restore raises it
// only from `core.agentResults[].sequence`, `../../harness.ts:14838`). Two roster rows can therefore
// report the SAME bare id — the conversation that ran it before the restart and the one the restarted
// process minted it for afterwards — and first-wins attributes one conversation's frames to the
// other, inside an inspection surface whose entire job is naming where a frame came from. Measured on
// the fixture below with the epoch resolution disabled: the post-restart child's `start` frame was
// reported as `threadId: 'thread-beta'`, the PRE-restart child's conversation.
//
// WHY THE CLIENT KEYING BY RUN IS NOW POSSIBLE (W22). The ids stay BARE on every wire — a bare id is what
// the client sends back (`../../server/api-mutations.ts` `parseTranscriptInvocationId`, `./invocations.ts`)
// and nothing composite may cross that boundary — but the roster row now carries the OTHER half of the
// store's run key beside them: the process that minted its latest invocation id
// (`../../server/protocol.ts` `SessionThread.epoch`, projected by `../../server/sessions.ts`
// `threadRoster`/`threadViewsOf` and `../../server/api-reads.ts` `threadRowOf`). The browser rebuilds
// `invocationRunKeyOf(id, epoch)` (`../../shared/run-identity.ts`) locally, so the join reaches the store's
// attribution rule from recorded data rather than inference. What the FRAMES carry (the epoch on every
// thread identity, `HarnessThread.epoch` in `../../types/index.ts`, stamped by `threadIdentity` in
// `../../harness.ts`) stays as the second source, for the documents whose roster rows predate the field.
//
// WHAT IS PINNED HERE:
//   F1 — a contested id resolves by the frame's epoch, from BOTH ends: the parent transcript splits
//        its two children along the generations, and the pre-restart child's own transcript no longer
//        swallows the post-restart sibling's frames (they belong to another conversation's run);
//   F2 — THE LEGACY DOOR: a document with no epoch anywhere produces EXACTLY the join it produced
//        before the field existed, so every recorded transcript is unchanged;
//   F3 — NO GUESSING: an epoch that fingerprints no claimant keeps the roster's first answer, and an
//        epoch nobody in the snapshot ran in changes nothing;
//   F4 — the descendant (`thread.parentId`) chain resolves with the CHILD's epoch — parent and child
//        were minted by the same process — and the bare-id cache is written ONLY by epoch-less frames,
//        so the legacy answer is the only thing that cache can ever hold;
//   F5 — THE W22 FIX: the F3 shape, resolved. Claimant rows that record `invocationId` + `epoch` answer
//        the contested id from that pair, the answer is the same with the roster reversed, and no
//        composite reaches a reported id;
//   F6 — the recorded pair still declines when both claimants name ONE process: a unique match decides,
//        anything else falls through to the roster's order rather than guessing.
//   F7 — THE EXPORT PLANE (W26): the same scenario with a roster shaped exactly like the REST roster PAGE
//        (`../../shared/harness-api.ts` `ThreadSummary`), renamed by `../view-api.ts` `threadRowOf` and
//        composed the way `../frontend/view-shell.ts` `getRawSession` composes the transcript document.
//        `ThreadSummary` carried NO invocation id when W22 shipped `epoch`, so on THIS path the token had
//        nothing beside it and the join could not key at all — pinned here in both directions: with the ids
//        the contested `15` resolves to the frame's own run (order-independent, no guess, no composite),
//        and with the ids absent (the pre-W26 page row) the legacy first-wins answer is all it can still do.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/thread-transcript-run-join.test.ts
//
// Cross-references: ./thread-transcript.ts (`claimantsOf` / `recordedRuns` / `rowEpochs` / `epochOwners` /
// `attributedThreadOf`), ./turns.ts `runKeyOf` + `parentKeyOf` (the same pairing for the turn board),
// ./thread-transcript.test.ts (the pre-W19 join contract, untouched by these pins),
// ../../server/sessions.epoch-discrimination.test.ts (the durable join on the server side),
// ../../server/api-reads.ts `threadRowOf`/`rosterInvocationIdsOf` (the producer of the F7 page rows),
// ../view-api.ts `threadRowOf` (the snake→camel rename F7 runs through) and ../view-shell.ts
// `getRawSession` (the transcript/export document it feeds),
// ../../server/api-thread-roster-invocation-ids.test.ts (the row's exact key order and emit rule).

import { describe, expect, it } from 'vitest';
import type { HarnessEvent, SessionSnapshot, SessionThread, SessionTurn } from '../../server/protocol';
// W26 (2026-11-17): F7 runs the export path for real — the roster PAGE row type and the rename that feeds
// the fold (`../view-shell.ts` `getRawSession`), so the pin cannot pass by hand-writing a shape the client
// never actually receives.
import type { ThreadSummary } from '../../shared/harness-api';
import { threadRowOf } from '../view-api';
import { buildThreadTranscriptJson } from './thread-transcript';

// Two ledger generations of one session. The client never sees a process, only these tokens on the
// frames, so literals are enough: the fingerprint is a relation between frames and roster rows.
const DEAD = 'epoch-dead-process';
const LIVE = 'epoch-live-process';

const threadOf = (overrides: Partial<SessionThread> & { id: string }): SessionThread => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    messages: [],
    ...overrides
});

const turnOf = (overrides: Partial<SessionTurn> & { id: string; index: number }): SessionTurn => ({
    prompt: 'go',
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [],
    ...overrides
});

// A frame's thread identity as the recorded event states it: the invocation id, its parent, and —
// since W19 — the process that minted them. No epoch is the legacy form.
const invocation = (id: string, epoch?: string, parentId?: string): Record<string, unknown> => ({
    id,
    ...(parentId === undefined ? {} : { parentId }),
    ...(epoch === undefined ? {} : { epoch })
});

const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread }) as unknown as HarnessEvent;

// THE SCENARIO, in roster order — the order that decides first-wins, which is why the pre-restart
// child comes first. The host `thread-root` owns both turns:
//   turn 0, BEFORE the restart: root `9`, `thread-alpha` as `11`, and alpha's delegated child
//     `thread-beta` as `15` and again as `10`;
//   turn 1, AFTER the restart: root `14`, `thread-alpha` again as `17`, and a NEW child conversation
//     `thread-gamma` as the recycled `15`, then again as `16`.
// `thread-alpha` is the transcript target in F1-F3, so every frame it attributes comes from a turn it
// does not own — exactly the join that has to be inferred. `15` is the contested id; `10` and `16` are
// what fingerprint the two children to their own generations.
const rosterOf = (
    gammaIds: string[],
    pairs: { beta?: [string, string]; gamma?: [string, string] } = {}
): SessionThread[] => [
    threadOf({ id: 'thread-root', sequence: 1, label: 'RR1', invocationIds: ['9', '14'] }),
    threadOf({
        id: 'thread-alpha',
        agent: 'Alpha',
        sequence: 2,
        label: 'RR2',
        ownerThreadId: 'thread-root',
        invocationIds: ['11', '17']
    }),
    threadOf({
        id: 'thread-beta',
        agent: 'Beta',
        sequence: 3,
        label: 'RR3',
        ownerThreadId: 'thread-alpha',
        invocationIds: ['15', '10'],
        // W22 (2026-11-17): a row that ran reports the process that minted its LATEST invocation id — the
        // pair the store records in one statement (`../../types/index.ts` `HarnessThreadRecord`) and the
        // server projects under one rule (`../../server/sessions.ts` `threadRoster`,
        // `../../server/protocol.ts` `SessionThread.epoch`). Omitted = the legacy row shape.
        ...(pairs.beta === undefined ? {} : { invocationId: pairs.beta[0], epoch: pairs.beta[1] })
    }),
    threadOf({
        id: 'thread-gamma',
        agent: 'Gamma',
        sequence: 4,
        label: 'RR4',
        ownerThreadId: 'thread-alpha',
        invocationIds: gammaIds,
        ...(pairs.gamma === undefined ? {} : { invocationId: pairs.gamma[0], epoch: pairs.gamma[1] })
    })
];

// One entry of the expected join, in scan order (turn index, then event index).
const entry = (
    invocationId: string,
    threadId: string,
    relation: 'target' | 'descendant',
    turnId: string,
    eventIndex: number
) => ({ invocationId, threadId, relation, turnId, eventIndex });

// The join `thread-alpha` gets when `15` resolves as stated: every uncontested id is unaffected, and
// the contested frame sits between `17` and `16` because that is where its event sits in turn 1.
const alphaJoin = (
    liveFifteen: { threadId: string; relation: 'target' | 'descendant' } | null
): ReturnType<typeof entry>[] => {
    const first = [
        entry('11', 'thread-alpha', 'target', 'turn-first', 1),
        entry('15', 'thread-beta', 'descendant', 'turn-first', 2),
        entry('10', 'thread-beta', 'descendant', 'turn-first', 3),
        entry('17', 'thread-alpha', 'target', 'turn-second', 1)
    ];

    if (liveFifteen !== null) {
        first.push(
            entry('15', liveFifteen.threadId, liveFifteen.relation, 'turn-second', 2),
            entry('16', 'thread-gamma', 'descendant', 'turn-second', 3)
        );
    }

    return first;
};

// THE RESOLVED ANSWER, shared by F5 (the `SessionThread` plane) and F7 (the export/`ThreadSummary` plane):
// one contested frame, one right answer, and the pin is the whole array — every uncontested id keeps its
// attribution, and the two generations split along the recorded run rather than along roster order.
const parentJoin = [
    entry('11', 'thread-alpha', 'target', 'turn-first', 1),
    entry('15', 'thread-beta', 'descendant', 'turn-first', 2),
    entry('10', 'thread-beta', 'descendant', 'turn-first', 3),
    entry('17', 'thread-alpha', 'target', 'turn-second', 1),
    entry('15', 'thread-gamma', 'descendant', 'turn-second', 2),
    entry('16', 'thread-alpha', 'target', 'turn-second', 3)
];

const betaJoin = [
    entry('15', 'thread-beta', 'target', 'turn-first', 2),
    entry('10', 'thread-beta', 'target', 'turn-first', 3)
];

// ---------------------------------------------------------------------------
// W26 (2026-11-17) — THE EXPORT PLANE: THE SAME SCENARIO AS A `ThreadSummary` PAGE
// ---------------------------------------------------------------------------

// One row EXACTLY as `GET /sessions/{id}/threads` sends it (`../../shared/harness-api.ts` `ThreadSummary`):
// snake_case, transcript-free, required fields only — so the keys under test are the optional ones.
const wireRowOf = (overrides: Partial<ThreadSummary> & { id: string; sequence: number }): ThreadSummary => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    transcript_state: 'ok',
    message_count: 0,
    has_transcript: false,
    ...overrides
});

// The export-path roster: the same four conversations as `rosterOf`, in wire spelling, with the same
// `pairs` knob. `withIdentity` is the W26 half of the experiment: `false` projects the PRE-W26 page row
// (W22's `epoch` with no invocation id beside it, because `ThreadSummary` published none).
const wireRosterOf = (
    gammaIds: string[],
    pairs: { beta?: [string, string]; gamma?: [string, string] } = {},
    withIdentity: boolean = true
): ThreadSummary[] => {
    // The identity block as the server writes it (`../../server/api-reads.ts` `threadRowOf`): the latest id,
    // the ids recorded here (oldest first, BARE), and the process that minted the latest one — three
    // separate fields, never the composite `id\0epoch`.
    const identity = (latest: string, ids: string[], epoch: string, on: boolean): Partial<ThreadSummary> =>
        on ? { invocation_id: latest, invocation_ids: ids, epoch } : { epoch };

    return [
        wireRowOf({
            id: 'thread-root',
            sequence: 1,
            label: 'RR1',
            ...(withIdentity ? { invocation_ids: ['9', '14'] } : {})
        }),
        wireRowOf({
            id: 'thread-alpha',
            agent: 'Alpha',
            sequence: 2,
            label: 'RR2',
            owner_thread_id: 'thread-root',
            ...(withIdentity ? { invocation_ids: ['11', '17'] } : {})
        }),
        wireRowOf({
            id: 'thread-beta',
            agent: 'Beta',
            sequence: 3,
            label: 'RR3',
            owner_thread_id: 'thread-alpha',
            ...(withIdentity ? { invocation_ids: ['15', '10'] } : {}),
            ...(pairs.beta === undefined
                ? {}
                : identity(pairs.beta[0] as string, ['15', '10'], pairs.beta[1] as string, withIdentity))
        }),
        wireRowOf({
            id: 'thread-gamma',
            agent: 'Gamma',
            sequence: 4,
            label: 'RR4',
            owner_thread_id: 'thread-alpha',
            ...(withIdentity ? { invocation_ids: gammaIds } : {}),
            ...(pairs.gamma === undefined
                ? {}
                : identity(pairs.gamma[0] as string, gammaIds, pairs.gamma[1] as string, withIdentity))
        })
    ];
};

// The document `../frontend/view-shell.ts` `getRawSession` hands the transcript dialog and the export: every
// roster row renamed through `../view-api.ts` `threadRowOf` (snake→camel), each with the transcript the
// export read fetched. A field the rename drops never reaches the fold — which is why the pin runs through
// the real rename instead of hand-writing camelCase rows.
const exportSnapshotOf = (rows: readonly ThreadSummary[], turns: SessionTurn[]): SessionSnapshot =>
    snapshotOf(rows.map((row) => ({ ...threadRowOf(row), messages: [] })) as unknown as SessionThread[], turns);

// `epochs[i]` is the process the i-th frame names; `undefined` is the legacy form.
const turnsOf = (epochs: (string | undefined)[]): SessionTurn[] => {
    const [rootOld, alphaOld, betaOld, betaAgain, rootNew, alphaNew, gammaRecycled, gammaNext] = epochs;

    return [
        turnOf({
            id: 'turn-first',
            index: 0,
            threadId: 'thread-root',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'm1' }, invocation('9', rootOld)),
                withThread({ type: 'start', agent: 'Alpha', model: 'm1' }, invocation('11', alphaOld, '9')),
                withThread({ type: 'start', agent: 'Beta', model: 'm1' }, invocation('15', betaOld, '11')),
                withThread({ type: 'start', agent: 'Beta', model: 'm1' }, invocation('10', betaAgain, '11'))
            ],
            eventTimes: [10, 11, 12, 13]
        }),
        turnOf({
            id: 'turn-second',
            index: 1,
            threadId: 'thread-root',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'm1' }, invocation('14', rootNew)),
                withThread({ type: 'start', agent: 'Alpha', model: 'm1' }, invocation('17', alphaNew, '14')),
                withThread({ type: 'start', agent: 'Gamma', model: 'm1' }, invocation('15', gammaRecycled, '17')),
                withThread({ type: 'start', agent: 'Gamma', model: 'm1' }, invocation('16', gammaNext, '17'))
            ],
            eventTimes: [20, 21, 22, 23]
        })
    ];
};

const snapshotOf = (threads: SessionThread[], turns: SessionTurn[]): SessionSnapshot => ({
    id: 's1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 10,
    messages: [],
    turns,
    threads
});

// The join, exactly as the document publishes it: which conversation each foreign frame was attributed
// to, with the turn/event provenance that makes the answer checkable. Ids stay BARE in the document —
// the client never learns the composite key.
const joinOf = (snapshot: SessionSnapshot, threadId: string) =>
    (buildThreadTranscriptJson(snapshot, threadId, { generatedAt: 1 })?.relatedEvents ?? []).map((record) => ({
        invocationId: record.invocationId,
        threadId: record.threadId,
        relation: record.relation,
        turnId: record.turnId,
        eventIndex: record.eventIndex
    }));

const bothGenerations = [DEAD, DEAD, DEAD, DEAD, LIVE, LIVE, LIVE, LIVE];

describe('the client transcript join resolves the run a frame belongs to', () => {
    it('splits a recycled invocation id along the epoch each frame carries (F1)', () => {
        const snapshot = snapshotOf(rosterOf(['15', '16']), turnsOf(bothGenerations));

        // THE PIN, parent end. `15` is contested — `thread-beta` ran it before the restart,
        // `thread-gamma` after — and the two are told apart by the ids ONLY they report: `10` appears
        // in DEAD frames, `16` in LIVE ones. Disabled resolution puts the LIVE frame on `thread-beta`
        // (first-wins), so `thread-gamma` loses a frame it ran while `thread-beta` gains one it never
        // ran. Note the answer is not "roster order": the LIVE frame resolves to the row listed LAST.
        expect(joinOf(snapshot, 'thread-alpha')).toEqual(
            alphaJoin({ threadId: 'thread-gamma', relation: 'descendant' })
        );

        // THE PIN, child end. Opening the PRE-restart child's transcript, the post-restart sibling is
        // outside this subtree, and the frame resolves cleanly to it — so the frame is not this
        // conversation's at all, and is left out rather than pulled in. Disabled, beta's document
        // carries the LIVE frame as its own `target`, i.e. a history entry beta never ran.
        expect(joinOf(snapshot, 'thread-beta')).toEqual([
            entry('15', 'thread-beta', 'target', 'turn-first', 2),
            entry('10', 'thread-beta', 'target', 'turn-first', 3)
        ]);

        // And the post-restart child sees its own frame and nothing else.
        expect(joinOf(snapshot, 'thread-gamma')).toEqual([
            entry('15', 'thread-gamma', 'target', 'turn-second', 2),
            entry('16', 'thread-gamma', 'target', 'turn-second', 3)
        ]);
    });

    it('keeps the exact first-wins join for a document with no epoch anywhere (F2)', () => {
        const legacy = snapshotOf(rosterOf(['15', '16']), turnsOf(new Array(8).fill(undefined)));

        // THE LEGACY DOOR. Every frame is epoch-less, so nothing fingerprints either claimant and the
        // join is the one this surface has always produced: `15` belongs to the roster's first claimant
        // in BOTH generations. Every transcript on disk predates the field, so this exact array IS the
        // unchanged legacy contract — the same array F1 produces for the pre-restart frames only.
        expect(joinOf(legacy, 'thread-alpha')).toEqual(alphaJoin({ threadId: 'thread-beta', relation: 'descendant' }));

        // The child end is unchanged too: with no epoch, beta's transcript keeps both `15` frames,
        // exactly as it did before the field existed.
        expect(joinOf(legacy, 'thread-beta')).toEqual([
            entry('15', 'thread-beta', 'target', 'turn-first', 2),
            entry('10', 'thread-beta', 'target', 'turn-first', 3),
            entry('15', 'thread-beta', 'target', 'turn-second', 2)
        ]);
    });

    it('keeps the roster answer when the epoch fingerprints neither claimant (F3)', () => {
        // W22 (2026-11-17) — WHAT THIS PIN NOW MEANS. This is the residual of an EPOCH-LESS ROSTER: the rows
        // below name their runs (`invocationIds`) but no process, so nothing in the roster can tell the two
        // claimants apart and only the frames could. The same shape WITH the process tokens the server now
        // publishes resolves by a recorded fact instead of by map order — pinned in F5 below.
        //
        // `thread-gamma` reports ONLY the contested id, so no frame can fingerprint it. The LIVE
        // frame's epoch names a process the record knows (`thread-alpha` ran `17` in it), but neither
        // claimant of `15`, and picking one here would attribute a frame on an inference the record
        // does not support: the roster's first answer stands. `16` has no roster row of its own any
        // more, so it is placed by the pre-existing `thread.parentId` inference — into `thread-alpha`,
        // the conversation that ran its parent — which is what this join did before W19 too.
        const partial = snapshotOf(rosterOf(['15']), turnsOf(bothGenerations));

        expect(joinOf(partial, 'thread-alpha')).toEqual([
            entry('11', 'thread-alpha', 'target', 'turn-first', 1),
            entry('15', 'thread-beta', 'descendant', 'turn-first', 2),
            entry('10', 'thread-beta', 'descendant', 'turn-first', 3),
            entry('17', 'thread-alpha', 'target', 'turn-second', 1),
            entry('15', 'thread-beta', 'descendant', 'turn-second', 2),
            entry('16', 'thread-alpha', 'target', 'turn-second', 3)
        ]);

        // A process NOBODY in this snapshot ran in changes nothing either: every contested id keeps the
        // roster's first answer, and every uncontested id still resolves normally.
        const elsewhere = snapshotOf(rosterOf(['15', '16']), turnsOf(new Array(8).fill('epoch-elsewhere')));

        expect(joinOf(elsewhere, 'thread-alpha')).toEqual(
            alphaJoin({ threadId: 'thread-beta', relation: 'descendant' })
        );
    });

    it('resolves a descendant chain with the child epoch and keeps the bare-id cache legacy-only (F4)', () => {
        // A delegated grandchild is recorded WITHOUT its own roster row: only `thread.parentId` names
        // its lineage (`20` → `15`). The parent is resolved with the CHILD's epoch, exactly as
        // `./turns.ts` `parentKeyOf` reasons — parent and child were minted by the same process — so
        // the recycled `15` resolves to `thread-gamma` for the LIVE frame.
        const deep = (epoch?: string): HarnessEvent =>
            withThread({ type: 'start', agent: 'Deep', model: 'm1' }, invocation('20', epoch, '15'));

        const deepTurn = (events: HarnessEvent[]) =>
            turnOf({ id: 'turn-deep', index: 2, threadId: 'thread-root', events, eventTimes: [30, 31] });

        const withEpoch = snapshotOf(rosterOf(['15', '16']), [...turnsOf(bothGenerations), deepTurn([deep(LIVE)])]);

        expect(joinOf(withEpoch, 'thread-alpha')).toContainEqual(
            entry('20', 'thread-gamma', 'descendant', 'turn-deep', 0)
        );

        // The same frame WITHOUT an epoch is the legacy path, and it still answers first-wins — the
        // answer this surface gave before the field existed.
        const legacy = snapshotOf(rosterOf(['15', '16']), [
            ...turnsOf(new Array(8).fill(undefined)),
            deepTurn([deep(undefined)])
        ]);

        expect(joinOf(legacy, 'thread-alpha')).toContainEqual(entry('20', 'thread-beta', 'descendant', 'turn-deep', 0));

        // The descendant cache is keyed by the bare id, so ONLY an epoch-less frame may write it: an
        // epoch-carrying frame must not publish `20 → thread-gamma` into the bare slot, or the legacy
        // frames of the same recycled descendant id would be pinned to the wrong conversation. Both
        // orders are pinned: the epoch frame never overwrites, and the legacy slot never wins over a
        // frame that CAN name its run.
        const epochThenLegacy = snapshotOf(rosterOf(['15', '16']), [
            ...turnsOf(bothGenerations),
            deepTurn([deep(LIVE), deep(undefined)])
        ]);

        expect(
            joinOf(epochThenLegacy, 'thread-alpha')
                .filter((record) => record.turnId === 'turn-deep')
                .map((record) => [record.invocationId, record.threadId, record.eventIndex])
        ).toEqual([
            ['20', 'thread-gamma', 0],
            ['20', 'thread-beta', 1]
        ]);

        const legacyThenEpoch = snapshotOf(rosterOf(['15', '16']), [
            ...turnsOf(bothGenerations),
            deepTurn([deep(undefined), deep(LIVE)])
        ]);

        expect(
            joinOf(legacyThenEpoch, 'thread-alpha')
                .filter((record) => record.turnId === 'turn-deep')
                .map((record) => [record.invocationId, record.threadId, record.eventIndex])
        ).toEqual([
            ['20', 'thread-beta', 0],
            ['20', 'thread-beta', 1]
        ]);
    });

    // W22 (2026-11-17) — THE RESIDUAL ABOVE IS CLOSED BY THE ROSTER ITSELF, and this is the case that was
    // ambiguous before. The server now publishes the run half of every recorded pair on the host/UI roster
    // (`../../server/sessions.ts` `threadRoster` → `../../server/protocol.ts` `SessionThread.epoch`, mirrored
    // on `SessionThreadView`), so the browser can rebuild the store's OWN attribution key —
    // `invocationRunKeyOf(invocationId, epoch)` (`../../shared/run-identity.ts`) — from two separate bare
    // fields. No composite crosses the wire, and no inference is needed: the frame's `id@epoch` matches the
    // pair exactly one row recorded.
    it('resolves the previously ambiguous id from the pair each claimant row records, order-independent (F5)', () => {
        // The F3 shape — `thread-gamma` reports ONLY the contested `15`, so no frame can fingerprint it —
        // with both claimants carrying the process that minted their latest run: beta `15`@DEAD, gamma
        // `15`@LIVE. The DEAD frame therefore names beta's recorded run and the LIVE frame gamma's.
        const rows = rosterOf(['15'], { beta: ['15', DEAD], gamma: ['15', LIVE] });
        const snapshot = snapshotOf(rows, turnsOf(bothGenerations));

        // THE PARENT END. `15` no longer belongs to whoever the roster happened to list first: the LIVE frame
        // moves to `thread-gamma`, the row listed LAST, and `16` (which has no row of its own) is still
        // placed by the pre-existing `thread.parentId` inference into `thread-alpha`. (`parentJoin` is the
        // module-level answer F7 pins again on the export plane, so the two planes are pinned to ONE array.)
        expect(joinOf(snapshot, 'thread-alpha')).toEqual(parentJoin);

        // THE CHILD END. Opening the pre-restart child, the post-restart sibling's frame resolves cleanly to
        // a conversation OUTSIDE this subtree, so it is not this conversation's history — beta's document
        // names only the two frames its own run recorded.
        expect(joinOf(snapshot, 'thread-beta')).toEqual(betaJoin);

        // And the post-restart child sees its own frame, with the pre-restart sibling's excluded.
        expect(joinOf(snapshot, 'thread-gamma')).toEqual([entry('15', 'thread-gamma', 'target', 'turn-second', 2)]);

        // ORDER INDEPENDENCE — the point of the whole change. Flipping the roster (the only thing that used
        // to decide a contested id) leaves every answer above exactly as it was, because the answer comes
        // from a recorded pair, not from map order.
        const reversed = snapshotOf([...rows].reverse(), turnsOf(bothGenerations));

        expect(joinOf(reversed, 'thread-alpha')).toEqual(parentJoin);
        expect(joinOf(reversed, 'thread-beta')).toEqual(betaJoin);
        expect(joinOf(reversed, 'thread-gamma')).toEqual([entry('15', 'thread-gamma', 'target', 'turn-second', 2)]);

        // The wire stays BARE in both halves: the composite run key is derived in this process and never
        // appears in a reported id, so what the client sends back is still a plain invocation id
        // (`../../server/api-mutations.ts` `parseTranscriptInvocationId`).
        for (const record of buildThreadTranscriptJson(snapshot, 'thread-alpha', { generatedAt: 1 })?.relatedEvents ??
            []) {
            expect(record.invocationId.includes('\u0000')).toBe(false);
        }
    });

    it('still declines to guess when the recorded pairs name one process for both claimants (F6)', () => {
        // Both rows carry a pair, and both name the SAME process: the LIVE frame's `15`@LIVE matches beta's
        // recorded run key exactly, so the document genuinely has two owners for that id and nothing in it
        // picks one. The recorded-run door then declines (it only answers a UNIQUE match) and the join keeps
        // the roster's first answer — the same conservative rule F3 pins for frames.
        const rows = rosterOf(['15'], { beta: ['15', LIVE], gamma: ['15', LIVE] });
        const snapshot = snapshotOf(rows, turnsOf(bothGenerations));

        expect(joinOf(snapshot, 'thread-alpha')).toEqual([
            entry('11', 'thread-alpha', 'target', 'turn-first', 1),
            entry('15', 'thread-beta', 'descendant', 'turn-first', 2),
            entry('10', 'thread-beta', 'descendant', 'turn-first', 3),
            entry('17', 'thread-alpha', 'target', 'turn-second', 1),
            entry('15', 'thread-beta', 'descendant', 'turn-second', 2),
            entry('16', 'thread-alpha', 'target', 'turn-second', 3)
        ]);
    });

    // W26 (2026-11-17) — THE PLANE THE PREVIOUS PINS NEVER TOUCHED. F1-F6 hand the fold `SessionThread`
    // rows, which is what `store.get()` / the stream publish and what a LIVE page holds. The transcript
    // dialog and the JSON export get something else: `../frontend/view-shell.ts` `getRawSession` builds its
    // roster from `GET /sessions/{id}/threads`, i.e. `ThreadSummary` rows renamed by `../view-api.ts`
    // `threadRowOf`. W22 published `epoch` on that row while the row named NO invocation id, so on the
    // export path the token had nothing beside it and door 1
    // (`./thread-transcript.ts` `recordedRuns` / `attributedThreadOf`) had no key to look up at all —
    // the discriminator worked only depending on which read the client made. W26 put `invocation_id`/
    // `invocation_ids` on the page row (`../../server/api-reads.ts` `threadRowOf`,
    // `../../server/api-thread-roster-invocation-ids.test.ts` pins that row's shape), and this test pins the
    // consequence: the F5 answer, reached through the wire row and the real rename.
    it('resolves the contested id on the export plane, where the roster is a ThreadSummary page (F7)', () => {
        const rows = wireRosterOf(['15'], { beta: ['15', DEAD], gamma: ['15', LIVE] });
        const snapshot = exportSnapshotOf(rows, turnsOf(bothGenerations));

        // THE RENAME CARRIES THE PAIR. `invocation_id`/`invocation_ids` are read out of the page row by the
        // same code path that used to answer them only for `/threads/{id}`; `epoch` sits beside them exactly
        // as the server emitted it, and nothing composite appears.
        expect(
            (snapshot.threads ?? []).map((thread) => [
                thread.id,
                thread.invocationId,
                thread.invocationIds,
                (thread as { epoch?: string }).epoch
            ])
        ).toEqual([
            ['thread-root', undefined, ['9', '14'], undefined],
            ['thread-alpha', undefined, ['11', '17'], undefined],
            ['thread-beta', '15', ['15', '10'], DEAD],
            ['thread-gamma', '15', ['15'], LIVE]
        ]);

        // THE PIN, PARENT END. Identical to F5: `15` belongs to the row that RECORDED the run the frame
        // names, not to the row the roster happened to list first, so the LIVE frame resolves to
        // `thread-gamma`, the last row.
        expect(joinOf(snapshot, 'thread-alpha')).toEqual(parentJoin);

        // THE PIN, CHILD ENDS. The pre-restart child excludes the post-restart sibling's frame (it resolves
        // to a conversation outside this subtree), and the post-restart child sees only its own.
        expect(joinOf(snapshot, 'thread-beta')).toEqual(betaJoin);
        expect(joinOf(snapshot, 'thread-gamma')).toEqual([entry('15', 'thread-gamma', 'target', 'turn-second', 2)]);

        // ORDER INDEPENDENCE on this plane too — reversing the WIRE rows changes nothing, because the answer
        // comes from a recorded pair, not from the order the page happened to send.
        const reversed = exportSnapshotOf([...rows].reverse(), turnsOf(bothGenerations));

        expect(joinOf(reversed, 'thread-alpha')).toEqual(parentJoin);
        expect(joinOf(reversed, 'thread-beta')).toEqual(betaJoin);
        expect(joinOf(reversed, 'thread-gamma')).toEqual([entry('15', 'thread-gamma', 'target', 'turn-second', 2)]);

        for (const record of buildThreadTranscriptJson(snapshot, 'thread-alpha', { generatedAt: 1 })?.relatedEvents ??
            []) {
            expect(record.invocationId.includes('\u0000')).toBe(false);
        }

        // WHY THE IDS WERE THE GAP. The same rows WITHOUT `invocation_id`/`invocation_ids` are the pre-W26
        // page: `epoch` alone, exactly what W22 shipped. A bare id is the only thing this fold can key by, so
        // with no id on any row there is no claimant map, no contest, and nothing to attribute — the export
        // produced an empty related-event list and could not have produced anything else. The `epoch` token
        // alone is a process with no run beside it; the pairing is the whole feature.
        const pageBeforeW26 = exportSnapshotOf(
            wireRosterOf(['15'], { beta: ['15', DEAD], gamma: ['15', LIVE] }, false),
            turnsOf(bothGenerations)
        );

        expect((pageBeforeW26.threads ?? []).map((thread) => [thread.invocationId, thread.invocationIds])).toEqual([
            [undefined, undefined],
            [undefined, undefined],
            [undefined, undefined],
            [undefined, undefined]
        ]);
        expect(joinOf(pageBeforeW26, 'thread-alpha')).toEqual([]);

        // F6 STILL HOLDS ON THIS PLANE: two claimants naming ONE process is not a collision the record can
        // settle, so the join declines and the roster's first answer stands — no guess between `thread-beta`
        // and `thread-gamma` just because the row now carries a pair.
        const oneProcess = exportSnapshotOf(
            wireRosterOf(['15'], { beta: ['15', LIVE], gamma: ['15', LIVE] }),
            turnsOf(bothGenerations)
        );

        expect(joinOf(oneProcess, 'thread-alpha')).toEqual([
            entry('11', 'thread-alpha', 'target', 'turn-first', 1),
            entry('15', 'thread-beta', 'descendant', 'turn-first', 2),
            entry('10', 'thread-beta', 'descendant', 'turn-first', 3),
            entry('17', 'thread-alpha', 'target', 'turn-second', 1),
            entry('15', 'thread-beta', 'descendant', 'turn-second', 2),
            entry('16', 'thread-alpha', 'target', 'turn-second', 3)
        ]);
    });
});
