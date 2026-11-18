// T-W8 — the PER-PROCESS EPOCH on run identity (`HarnessThread.epoch`).
//
// WHY THIS FILE EXISTS. The runtime's `thread.id` is the INVOCATION counter
// (`runSequence`, ../harness.ts), and that counter is per PROCESS: a restarted harness
// begins it again and a lane worker mints from its own (`reserveIdentity` only ever RAISES
// the leased mark). The turn projector can split two runs wearing one id by their identity
// SHAPE or by a `start` recorded after a row closed (./server/turn-projector.ts
// `isRunBoundary`), but not when the spawn `callId` was recycled as well and the dead row is
// still open — the residual F5 left exactly there. `HarnessThread.epoch` closes it with a
// fact instead of an inference: it names the process that minted the id.
//
// What is pinned here, one contract per `it`:
//   1. EVERY frame of a non-root run carries the process epoch — `start` and the identity
//      copy on later frames (../harness.ts `threadIdentity`), the `input`-free shape
//      unchanged apart from the new key;
//   2. a ROOT run still emits no `thread` at all (the recorded shape of a root run did not
//      move), and the epoch is a PROCESS fact, not a run fact: two turns of one harness —
//      and two harnesses of one process — carry the SAME value while their ids differ;
//   3. the epoch is NOT persisted and NOT restored: `snapshot()` names no epoch and
//      `restore()` cannot forge one, which is precisely why a replica in a new process gets a
//      new value and a post-restart frame can never claim a pre-restart run's row;
//   4. a HOST-thread conversation's own frames are ROOT-SHAPED and epoch-bearing — the mint
//      the F5 residual needed, because the shape test cannot separate a conversation's
//      pre-restart run from the run that continues it under a recycled id;
//   5. a branch's AUDIT frames (`branch_start` / `branch_end`, which bypass `emit`) carry the
//      epoch too, so a branch row — whose `branch-N` id is a per-process counter as well —
//      is separable across a restart.
//
// The LANE half of the contract (a lane worker's ids are distinguishable from the parent
// process's) is not provable from inside one module registry: a lane is a real
// `node:worker_threads` worker with its own registry, so it mints its OWN epoch. That
// assertion lives beside a real lane in ./server/workers/lane-worker-correctness.test.ts.
//
// Clock policy: no fake timers and no pinned clock — nothing below asserts a wall-clock
// figure. The epoch value is asserted against the constant the same module registry minted
// (`HARNESS_PROCESS_EPOCH`), never against a literal, because it is random BY DESIGN; the
// exact-string stability that matters is asserted as "equal to the process's own epoch".
//
// Run: yarn vitest run src/harness.thread-epoch.test.ts   (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';
// The mint itself, from the dependency-free leaf `../harness.ts` imports (NOT the package
// barrel): same absolute module id, so this is the SAME instance the runs below minted their
// frames with — a different one would make every assertion below vacuous.
import { HARNESS_PROCESS_EPOCH } from './core/agent-limits';

// One scripted frame list per request; the last list is reused when a run asks for more
// requests than were scripted (the same helper ./harness.threads.test.ts uses).
const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* stream() {
        const frames = turns[index] ?? turns[turns.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream) => agent({ model: 'scripted/test', stream });

// A harness whose every reported frame is captured, so a test can read the exact thread
// payload off the exact frame the store would have recorded.
const recorder = () => {
    const events: HarnessEvent[] = [];

    return {
        events,
        report: { progress: (event: HarnessEvent): void => void events.push(event) }
    };
};

describe('run identity carries the process epoch (T-W8)', () => {
    it('stamps every frame of a delegated child with the epoch that minted its id', async () => {
        const { events, report } = recorder();
        const writer = harness({
            agents: {
                lead: brain(
                    scripted([callTool('c1', 'delegate', '{"agent":"helper","input":"find it"}'), answer('lead done')])
                ),
                helper: brain(scripted([answer('child answer')]))
            },
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            presets: false,
            report
        });

        await writer('go');

        // One id, one epoch, EVERY frame. `input` still travels on `start` only (the recorded
        // shape did not change), and the epoch rides the identity copy exactly like
        // `callId`/`kind`/`branchId` do — a reader has to be able to tell a run apart at any
        // frame, not only at its first.
        expect(events.filter((event) => event.agent === 'helper').map((event) => event.thread)).toEqual([
            { id: '2', callId: 'c1', input: 'find it', epoch: HARNESS_PROCESS_EPOCH },
            { id: '2', callId: 'c1', epoch: HARNESS_PROCESS_EPOCH },
            { id: '2', callId: 'c1', epoch: HARNESS_PROCESS_EPOCH }
        ]);

        // (2) The ROOT run is untouched: a root run has no thread, so a pre-thread record and a
        // post-change one are byte-identical for the turn's own flow.
        expect(events.filter((event) => event.agent === 'lead').every((event) => !('thread' in event))).toBe(true);
    });

    it('keeps the epoch stable across runs and harnesses of one process while the ids move', async () => {
        const { events, report } = recorder();
        const scriptedLead = scripted([
            callTool('c1', 'delegate', '{"agent":"helper","input":"first"}'),
            answer('lead one'),
            callTool('c2', 'delegate', '{"agent":"helper","input":"second"}'),
            answer('lead two')
        ]);
        const configuration = {
            agents: { lead: brain(scriptedLead), helper: brain(scripted([answer('child answer')])) },
            // `as const` keeps the rank letters as literal types: this object is declared
            // separately and passed to `harness(configuration)`, so it gets no contextual
            // type from the call and a bare `'A'` would widen to `string`.
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' } as const,
            presets: false,
            report
        };

        const writer = harness(configuration);

        await writer('go');
        await writer('again');

        const childThreads = events.filter((event) => event.agent === 'helper' && event.thread !== undefined);
        const childIds = childThreads.map((event) => String(event.thread?.id));

        // Two turns, two delegated children, DIFFERENT invocation ids (the counter is
        // monotonic per harness) and the SAME epoch — the epoch is not a run id bolted on, it
        // is the process the runs happened in.
        expect([...new Set(childIds)]).toEqual(['2', '4']);
        expect([...new Set(childThreads.map((event) => String(event.thread?.epoch)))]).toEqual([HARNESS_PROCESS_EPOCH]);

        // A SECOND harness in the same process mints different ids and the same epoch: the
        // value is module-scoped, so it cannot be used to tell two harnesses of one process
        // apart, and that is exactly the granularity the projector needs (the process, the
        // only place an id can be recycled, is the only thing it discriminates on).
        const sibling = harness(configuration);

        await sibling('go');

        expect(HARNESS_PROCESS_EPOCH).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    });

    it('carries the epoch on the rows a run wrote, never on the harness itself, so a replica cannot forge one', async () => {
        const source = recorder();
        const writer = harness({
            agents: {
                lead: brain(
                    scripted([callTool('c1', 'delegate', '{"agent":"helper","input":"find it"}'), answer('lead done')])
                ),
                helper: brain(scripted([answer('child answer')]))
            },
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            presets: false,
            report: source.report
        });

        await writer('go');

        const snapshot = writer.snapshot();

        // THE DURABILITY HALF, restated by W19 (2026-11-17). The epoch IS in the document now — on the
        // ledger rows (`agentResults[].epoch`, ../core/snapshot.ts) and beside a conversation's
        // invocation id (`threads[].epoch`, ../types/index.ts) — precisely BECAUSE the ids alone are not
        // evidence of anything: the snapshot carries per-process id high-water marks (../harness.ts:8462),
        // so after a restart the same bare id names a DIFFERENT run, and only the generation that wrote a
        // row says which one it is. What the rule still forbids — and what this pin still guards — is
        // FORGERY by the harness itself: the token appears in no field that describes the harness, its
        // agents, its discovery offsets or its records store, so a snapshot can never carry a process
        // IDENTITY into a new process. A replica inherits ROWS, keeps the generation each row was written
        // in, and stamps only the runs it performs itself. (A durable PROCESS identity would make the
        // discriminator decorative; a durable per-row one is what makes it work at all.)
        expect(JSON.stringify(snapshot)).toContain(HARNESS_PROCESS_EPOCH);

        // Stamped exactly where a run was written, paired with the invocation id each row carries — the
        // pairing rule ../core/snapshot.ts enforces on restore (an `epoch` without an `invocationId` is
        // refused, so a forged discriminator cannot be attached to a row that names no run).
        expect((snapshot.agentResults ?? []).map((row) => [row.invocationId, row.epoch])).toEqual([
            ['1', HARNESS_PROCESS_EPOCH],
            ['2', HARNESS_PROCESS_EPOCH]
        ]);

        // And nowhere else: the same document with its ledger removed names no process at all.
        const { agentResults: _ledger, ...withoutLedger } = snapshot;

        expect(JSON.stringify(withoutLedger)).not.toContain(HARNESS_PROCESS_EPOCH);

        const restored = recorder();
        const target = harness({
            agents: {
                lead: brain(
                    scripted([callTool('c2', 'delegate', '{"agent":"helper","input":"again"}'), answer('lead done')])
                ),
                helper: brain(scripted([answer('child answer')]))
            },
            entry: 'lead',
            ranks: { lead: 'A', helper: 'B' },
            presets: false,
            report: restored.report
        });

        // `restore()` raises the counters (the id the restored replica mints continues the
        // archived sequence) and says nothing about the epoch: the frames it emits carry THIS
        // process's epoch, because that is the only honest answer available.
        target.restore(snapshot);
        await target('go');

        expect(restored.events.filter((event) => event.agent === 'helper').map((event) => event.thread)).toEqual([
            { id: '4', callId: 'c2', input: 'again', epoch: HARNESS_PROCESS_EPOCH },
            { id: '4', callId: 'c2', epoch: HARNESS_PROCESS_EPOCH },
            { id: '4', callId: 'c2', epoch: HARNESS_PROCESS_EPOCH }
        ]);
    });

    it('stamps a host conversation own root-shaped frame, the mint F5 could not separate', async () => {
        const { events, report } = recorder();
        const writer = harness({
            agents: { writer: brain(scripted([answer('host answer')])) },
            entry: 'writer',
            presets: false,
            report
        });

        const thread = writer.createThread('writer');
        const from = events.length;

        await writer.sendThreadInput(thread.id, 'host turn');

        const frames = events.slice(from);

        // A HOST-thread run is ROOT-SHAPED (no parent, no spawn call, no kind, no branch) yet
        // still carries `thread` — so the projector's shape test CANNOT tell the run a turn
        // started with from the run a restarted process continues it with, and the two can
        // share a recycled invocation id (the live artifact recorded the resumed conversation
        // under a dead child's id). The epoch is the only fact on the frame that says which
        // process wrote it, which is why this mint is stamped too.
        expect(frames.filter((event) => event.thread !== undefined).map((event) => event.thread)).toEqual([
            { id: '1', input: 'host turn', epoch: HARNESS_PROCESS_EPOCH },
            { id: '1', epoch: HARNESS_PROCESS_EPOCH },
            { id: '1', epoch: HARNESS_PROCESS_EPOCH }
        ]);
    });

    it('stamps the branch audit frames that bypass the event emitter', async () => {
        const { events, report } = recorder();
        const writer = harness({
            agents: {
                lead: brain(scripted([callTool('f1', 'threadFork', '{"input":"branch task"}'), answer('lead done')]))
            },
            entry: 'lead',
            presets: false,
            report
        });

        await writer('go');

        const auditFrames = events.filter((event) => event.type === 'branch_start' || event.type === 'branch_end');

        expect(auditFrames.map((event) => event.thread?.epoch)).toEqual([HARNESS_PROCESS_EPOCH, HARNESS_PROCESS_EPOCH]);

        // The branch id itself is a per-process counter, so the same recycled-name collision
        // F5 fixed for runs applies to branch rows too; the audit frames are the only frames
        // whose mint sits OUTSIDE `emit`, and they are stamped all the same (../harness.ts
        // `branchThreadOf`).
        expect(auditFrames.map((event) => event.thread?.kind)).toEqual(['fork', 'fork']);
        expect(String(auditFrames[0]?.thread?.id)).toBe(String(auditFrames[0]?.thread?.branchId));
    });
});
