// W19 (2026-11-17) — THE INVOCATION LEDGER IS ADDRESSED BY A RUN, NOT BY A RECYCLABLE ID
//
// THE DEFECT (survived the earlier run-key work, which only scoped the server's join and the display
// fold). `invocationId` comes from `runSequence`, a PER-PROCESS counter (`./harness.ts:8462`, and a
// restore only ever RAISES it at ./harness.ts:14854). After a restart the harness mints `15` again, for
// somebody else's run. The canonical ledger — `invocationRecords`, the thing `core.agentResults` persists
// — was keyed by that BARE id, so the second run OVERWROTE the first one's row:
//
//   * a post-restart query of an id the caller was given BEFORE the restart answered the WRONG run, or
//     the answer was simply gone (the pre-restart archive was discarded, not kept);
//   * a lane row and a coordinator row of one generation could collide the same way, because a lane worker
//     mints ids from its OWN counter (`reserveIdentity`, ./harness.ts:8432);
//   * and `archiveInvocation` reported `replaced: true` for a row that was never replaced.
//
// THE FIX. Every ledger address is the run key `id\0epoch` (`./shared/run-identity.ts`, the same rule the
// server's join, `./server/turn-projector.ts` and `../frontend/ui/turns.ts` use), and the row carries its
// epoch so the NEXT restore rebuilds the same address. A bare-id query keeps a fixed, documented
// preference (`invocationRecordOfInvocationId`, ./harness.ts:4123): this process's row, then the
// epoch-less row (the legacy door), then the newest row of another generation by `sequence`.
//
// WHAT IS PINNED HERE — each numbered item is the REQUIREMENT, not an observation:
//   1. two runs of ONE recycled id, in two ledger generations, each get THEIR OWN row, and the archived
//      pre-restart row is NOT discarded by the second archive;
//   2. the post-restart read of that id answers the POST-restart run — the pre-restart answer can never
//      be served for a post-restart query, before or after a restore;
//   3. a pre-restart result is still reachable by the id the caller was given when it is the only row of
//      that id (no regression for old documents);
//   4. `replaced` is reported on the RUN: two archives of one generation still replace one row (the
//      lane/coordinator same-slot semantics are unchanged), and two generations never do;
//   5. LEGACY — a document whose rows carry no epoch restores BYTE-IDENTICALLY: the reader invents no key,
//      the re-projected rows are the same keys in the same order, the duplicate refusal uses the
//      pre-change sentence, and the transition is stated: a run of THIS process wearing one of those ids
//      gets its own row rather than erasing the archive it inherited (the reads are identical either
//      way, because the bare-id query prefers this process's row first);
//   6. one document MAY hold one bare id twice when the rows name different generations, and it refuses
//      the same RUN twice;
//   7. the retention bound is UNCHANGED — `AGENT_RESULT_RETENTION` (64) rows — with one row per run, so a
//      cross-generation id costs exactly one extra row and evicts the oldest run;
//   8. the thread half of the pair: `HarnessThreadRecord.epoch` travels WITH `invocationId` (never
//      without it), round-trips through `snapshot()`/`restore()`, and is refused by the reader when it
//      appears on a row that names no invocation.
//
// Everything runs offline: scripted brains, and `archiveInvocation` — the seam the lane commits through —
// for the cross-generation rows. `HARNESS_PROCESS_EPOCH` is random per process (one per test file under
// vitest), so every assertion names the imported constant instead of a literal.
//
// Cross-references:
//   - ./shared/run-identity.ts — the key rule; ./server/protocol.ts re-exports it for the server
//   - ./harness.ts:4123 `invocationRecordOfInvocationId` (the bare-id preference), :4196
//     `registerInvocation`, :4243 `finishInvocation`, :8226 `archiveInvocation`, :14376 the projection,
//     :14789 the restore
//   - ./core/snapshot.ts — the whitelist, the optional-ness, and the duplicate rule moved onto the run
//   - ./types/index.ts — `HarnessAgentResultSnapshot.epoch`, `HarnessInvocationArchiveInput.epoch`,
//     `HarnessThreadRecord.epoch`, `HarnessThreadSnapshot.epoch`

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { HarnessInvocationArchiveInput, HarnessStream } from '@underload/harness';
// The per-process ledger generation, exactly as the runtime stamps it (./core/agent-limits.ts).
import { HARNESS_PROCESS_EPOCH } from './core/agent-limits';

// A brain that never runs in these tests: the ledger doors need a REGISTERED agent, not a model call.
const idleStream: HarnessStream = async function* () {
    yield { type: 'text', delta: 'unused' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const coreOf = () =>
    harness({
        agents: { writer: agent({ model: 'merge/ds4-flash', instruction: 'sys', stream: idleStream }) },
        presets: false
    });

// `rank: 'A'` is the rank of the only agent in `coreOf()` (./types rank rule 1: with no
// `ranks` map the entry agent holds Rank A). It replaces the removed primary/subagent
// `role` field, and snapshot v3 REFUSES a row that still carries `role`, so this helper
// cannot stay lenient.
//
// The ledger generation of a process that has ALREADY ENDED. The name is arbitrary on purpose: the
// runtime never parses an epoch, it only compares one (`./shared/run-identity.ts`).
const DEAD_EPOCH = 'epoch-pre-restart';

const archivedRow = (
    invocationId: string,
    sequence: number,
    content: string,
    epoch?: string
): HarnessInvocationArchiveInput => ({
    invocationId,
    sequence,
    agent: 'writer',
    rank: 'A',
    kind: 'root',
    status: 'completed',
    content,
    ...(epoch === undefined ? {} : { epoch })
});

describe('the invocation ledger is addressed by a run', () => {
    // 1 + 4 — the two rows, and the honesty of `replaced`.
    it('keeps the pre-restart row beside the row of the id this process re-minted', () => {
        const source = coreOf();

        // A run of the process that has since ended, archived with the epoch that minted its id.
        const before = source.archiveInvocation(archivedRow('15', 15, 'pre-restart answer', DEAD_EPOCH));

        expect(before.replaced).toBe(false);

        // The SAME bare id, minted again by THIS process. Before W19 this call addressed the bare key
        // `15`, overwrote the row above, and reported `replaced: true`.
        const after = source.archiveInvocation(archivedRow('15', 16, 'post-restart answer'));

        expect(after.replaced).toBe(false);

        // Both rows, in the projection's own order (by run `sequence`), each naming the ledger
        // generation that minted its id.
        expect(source.snapshot().agentResults).toEqual([
            {
                invocationId: '15',
                sequence: 15,
                completedOrder: 1,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'pre-restart answer',
                epoch: DEAD_EPOCH
            },
            {
                invocationId: '15',
                sequence: 16,
                completedOrder: 2,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'post-restart answer',
                epoch: HARNESS_PROCESS_EPOCH
            }
        ]);
    });

    // 2 — the headline read: a post-restart query can never be served the pre-restart answer.
    it('answers the post-restart run for the recycled id, and survives a restart the same way', async () => {
        const source = coreOf();

        source.archiveInvocation(archivedRow('15', 15, 'pre-restart answer', DEAD_EPOCH));
        source.archiveInvocation(archivedRow('15', 16, 'post-restart answer'));

        expect(await source.executeTool('agentResult', { agent: 'writer', invocationId: '15' })).toEqual({
            agent: 'writer',
            invocationId: '15',
            kind: 'root',
            status: 'completed',
            content: 'post-restart answer',
            contentLength: 19,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // THE RESTART: the durable document is what a new process reads, so the fix has to be in the
        // bytes, not only in the live map. JSON on purpose — this is the shape a server writes.
        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);

        // Both generations are still in the document the restart produced...
        expect(reloaded.snapshot().agentResults).toEqual(source.snapshot().agentResults);

        // ...and the query still answers THIS process's run. Before the fix there was exactly one row
        // left after the restore, and it was whichever row the writer touched last.
        expect(await reloaded.executeTool('agentResult', { agent: 'writer', invocationId: '15' })).toEqual({
            agent: 'writer',
            invocationId: '15',
            kind: 'root',
            status: 'completed',
            content: 'post-restart answer',
            contentLength: 19,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    // 3 — a pre-restart result stays addressable by the id its caller was given.
    it('still answers an older generation by its id when it is the only row of that id', async () => {
        const source = coreOf();

        source.archiveInvocation(archivedRow('15', 15, 'pre-restart answer', DEAD_EPOCH));

        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);

        // Bare-id preference step 3 (`./harness.ts:4132`): no row of this process, no epoch-less row, so
        // the newest row of another generation answers. This is what keeps every id a client was handed
        // working across a restart.
        expect(await reloaded.executeTool('agentResult', { agent: 'writer', invocationId: '15' })).toEqual({
            agent: 'writer',
            invocationId: '15',
            kind: 'root',
            status: 'completed',
            content: 'pre-restart answer',
            contentLength: 18,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    // 2b — the plane the MODEL reads: after a restore, a fresh run of the restored process answers from
    // ITS OWN ledger generation, not from a pre-restart row that happens to wear a recycled id.
    it('answers a fresh run with its own result, not the pre-restart row of a recycled id', async () => {
        const source = coreOf();

        source.archiveInvocation(archivedRow('15', 15, 'pre-restart answer', DEAD_EPOCH));
        source.archiveInvocation(archivedRow('15', 16, 'post-restart answer'));

        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);

        // A real run in the restored process, so the answer below is THIS generation's row.
        await reloaded('go');

        const answer = (await reloaded.executeTool('agentResult', { agent: 'writer' })) as {
            invocationId: string;
            content: string;
            status: string;
        };

        // The restored process mints the NEXT id (`runSequence` is raised from the persisted high-water,
        // ./harness.ts:14854), and its own run is the newest row of `writer` — the pre-restart row can
        // only ever be reached by the id its caller was given.
        expect({ invocationId: answer.invocationId, status: answer.status, content: answer.content }).toEqual({
            invocationId: '17',
            status: 'completed',
            content: 'unused'
        });
    });

    // 4 — the legacy addressing of ONE generation is untouched: same slot, replace, one row.
    it('replaces within one ledger generation, which is the lane/coordinator pairing of today', () => {
        const source = coreOf();

        // A cancelled lane row, then the completed row of the SAME run. Neither names an epoch, because
        // the seam's contract is "absent means this process's generation" — the row that already exists
        // here was written by the same process too.
        source.archiveInvocation({
            ...archivedRow('15', 15, ''),
            status: 'cancelled',
            error: 'The run was cancelled.',
            content: ''
        });

        const completed = source.archiveInvocation(archivedRow('15', 15, 'the finished answer'));

        expect(completed.replaced).toBe(true);

        const rows = source.snapshot().agentResults ?? [];

        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({
            invocationId: '15',
            sequence: 15,
            completedOrder: 2,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'the finished answer',
            epoch: HARNESS_PROCESS_EPOCH
        });
    });

    // An archive may NAME a foreign generation explicitly, and a malformed one is refused rather than
    // coerced — an epoch that quietly became `''` would re-key the row into somebody else's slot.
    it('refuses an epoch the seam cannot name', () => {
        const source = coreOf();

        expect(() => source.archiveInvocation({ ...archivedRow('16', 17, 'x'), epoch: '' })).toThrow(
            'Invocation "16".epoch must be at least 1 character.'
        );
        expect(() =>
            source.archiveInvocation({ ...archivedRow('16', 17, 'x'), epoch: 7 as unknown as string })
        ).toThrow('Invocation "16".epoch must be a string.');

        // Nothing moved: no row, and no burned completion order.
        expect(source.snapshot().agentResults ?? []).toEqual([]);
    });

    // 5 — the legacy door, pinned against DATA rather than against this build's own writer.
    it('restores an epoch-less document with no new key and its old addressing', async () => {
        const base = coreOf();
        const document = base.snapshot() as Record<string, unknown>;

        // A literal array: exactly the rows every file written before this change holds.
        document.agentResults = [
            {
                invocationId: '15',
                sequence: 15,
                completedOrder: 1,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'legacy answer'
            }
        ];

        const target = coreOf();

        target.restore(JSON.parse(JSON.stringify(document)) as never);

        // The reader invents nothing: the re-projected row carries NO `epoch` key, with the same key set
        // it came in with, in the same order.
        const rows = (target.snapshot().agentResults ?? []) as Record<string, unknown>[];

        expect(rows).toEqual([
            {
                invocationId: '15',
                sequence: 15,
                completedOrder: 1,
                agent: 'writer',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: 'legacy answer'
            }
        ]);
        expect(Object.keys(rows[0])).toEqual([
            'invocationId',
            'sequence',
            'completedOrder',
            'agent',
            // V3 put `rank` exactly where v2 kept `role`, so the key ORDER of a row is
            // pinned too: the server persists these rows verbatim and a reorder is a
            // shape change, not a rename.
            'rank',
            'kind',
            'status',
            'content'
        ]);

        // And it still answers, through the bare-id door (preference step 2).
        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId: '15' })).toEqual({
            agent: 'writer',
            invocationId: '15',
            kind: 'root',
            status: 'completed',
            content: 'legacy answer',
            contentLength: 13,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // THE UPGRADE BOUNDARY: the epoch-less row is by construction another build's ledger generation
        // (this one always writes the key), so a run of THIS process that wears the same bare id is a
        // different run and gets its own row instead of erasing the archive it inherited. The reads are
        // unchanged either way — the bare-id query prefers this process's row first — and the row this
        // process cannot address stays where the next snapshot writes it.
        const replaced = target.archiveInvocation(archivedRow('15', 15, 're-archived answer'));

        expect(replaced.replaced).toBe(false);

        const rowsAfter = target.snapshot().agentResults ?? [];

        expect(rowsAfter).toHaveLength(2);
        expect(rowsAfter[0]).toEqual({
            invocationId: '15',
            sequence: 15,
            completedOrder: 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'legacy answer'
        });
        expect(rowsAfter[1]).toEqual({
            invocationId: '15',
            sequence: 15,
            completedOrder: 2,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 're-archived answer',
            epoch: HARNESS_PROCESS_EPOCH
        });
    });

    // 6 — the uniqueness rule, on both sides of the change.
    it('refuses a duplicate bare id in an epoch-less document with the pre-change sentence', () => {
        const base = coreOf();
        const document = base.snapshot() as Record<string, unknown>;

        const legacyRow = {
            invocationId: '15',
            sequence: 15,
            completedOrder: 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'legacy answer'
        };

        document.agentResults = [legacyRow, { ...legacyRow, sequence: 16, completedOrder: 2 }];

        const target = coreOf();

        // Two epoch-less rows of one id are STILL one row too many, and the sentence a restart test pins
        // has not moved: no epoch is involved, so no epoch is named.
        expect(() => target.restore(JSON.parse(JSON.stringify(document)) as never)).toThrow(
            'snapshot.agentResults contains the duplicate invocationId "15".'
        );
    });

    it('accepts one bare id twice when the rows name different generations, and refuses one run twice', async () => {
        const base = coreOf();
        const document = base.snapshot() as Record<string, unknown>;

        const row = {
            invocationId: '15',
            completedOrder: 1,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed'
        };

        document.agentResults = [
            { ...row, sequence: 15, content: 'pre-restart answer', epoch: DEAD_EPOCH },
            { ...row, sequence: 16, completedOrder: 2, content: 'post-restart answer', epoch: HARNESS_PROCESS_EPOCH }
        ];

        const target = coreOf();

        target.restore(JSON.parse(JSON.stringify(document)) as never);

        expect(target.snapshot().agentResults).toEqual([
            { ...row, sequence: 15, content: 'pre-restart answer', epoch: DEAD_EPOCH },
            { ...row, sequence: 16, completedOrder: 2, content: 'post-restart answer', epoch: HARNESS_PROCESS_EPOCH }
        ]);

        // The same RUN claimed twice — one id, one epoch — is still refused, with the run named.
        const clashDocument = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;

        clashDocument.agentResults = [
            { ...row, sequence: 15, content: 'first', epoch: DEAD_EPOCH },
            { ...row, sequence: 16, completedOrder: 2, content: 'second', epoch: DEAD_EPOCH }
        ];

        const clash = coreOf();

        expect(() => clash.restore(clashDocument as never)).toThrow(
            `snapshot.agentResults contains the duplicate invocationId "15" of epoch "${DEAD_EPOCH}".`
        );
    });

    // 7 — the retention arithmetic, unchanged by the run key.
    it('retains 64 rows, one per run, so a cross-generation id costs exactly one extra row', () => {
        const source = coreOf();

        // 70 RUNS archived: sequences 1..64 are THIS process's own ids `1`..`64`; sequences 65..70 are six
        // runs of the DEAD generation wearing ids `59`..`64` again — the recycled-id case, archived
        // afterwards.
        for (let sequence = 1; sequence <= 64; sequence++) {
            source.archiveInvocation(archivedRow(String(sequence), sequence, `answer ${sequence}`));
        }

        for (let offset = 1; offset <= 6; offset++) {
            source.archiveInvocation(
                archivedRow(String(58 + offset), 64 + offset, `dead answer ${58 + offset}`, DEAD_EPOCH)
            );
        }

        const rows = source.snapshot().agentResults ?? [];

        // The cap is still `AGENT_RESULT_RETENTION` (64): the fix did not double the ledger, because one
        // run still costs exactly one row. What changed is WHICH 64: the six cross-generation rows evict
        // the six OLDEST runs (sequences 1..6), not the pre-restart archives.
        expect(rows).toHaveLength(64);
        expect(rows.map((record) => record.sequence)).toEqual(Array.from({ length: 64 }, (_, index) => index + 7));

        // The exact rows, spelled `sequence:id:generation`. `59`..`64` appear TWICE — once per ledger
        // generation — and that is the whole cost of a recycled id: one extra row.
        expect(
            rows.map(
                (record) =>
                    `${record.sequence}:${record.invocationId}:${record.epoch === DEAD_EPOCH ? 'dead' : 'current'}`
            )
        ).toEqual([
            ...Array.from({ length: 58 }, (_, index) => `${index + 7}:${index + 7}:current`),
            '65:59:dead',
            '66:60:dead',
            '67:61:dead',
            '68:62:dead',
            '69:63:dead',
            '70:64:dead'
        ]);

        // The two oldest runs are gone, and the reader still refuses a document over the cap.
        expect(rows[0]).toEqual({
            invocationId: '7',
            sequence: 7,
            completedOrder: 7,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'answer 7',
            epoch: HARNESS_PROCESS_EPOCH
        });
        expect(rows.at(-1)).toEqual({
            invocationId: '64',
            sequence: 70,
            completedOrder: 70,
            agent: 'writer',
            rank: 'A',
            kind: 'root',
            status: 'completed',
            content: 'dead answer 64',
            epoch: DEAD_EPOCH
        });
        expect(new Set(rows.map((record) => record.invocationId)).size).toBe(58);
    });

    // 8 — the thread half of the pair. The full thread-row shape is pinned in
    // ./harness.threads.test.ts; this pins the W19 pair rule and its durability.
    it('stamps the epoch when the id is stamped, and round-trips it', () => {
        const source = coreOf();
        const thread = source.createThread('writer');

        // A status move with NO id changes nothing: the row had no id, so it has no epoch either.
        const statusOnly = source.setThreadStatus(thread.id, 'idle');

        expect(statusOnly.invocationId).toBeUndefined();
        expect(statusOnly.epoch).toBeUndefined();

        // The id and the epoch are ONE mint: `setThreadStatus` is the authority mirror write, and it
        // runs in the realm that minted the id (`./harness.ts:8110`).
        const stamped = source.setThreadStatus(thread.id, 'idle', '15');

        expect({ id: stamped.id, invocationId: stamped.invocationId, epoch: stamped.epoch }).toEqual({
            id: thread.id,
            invocationId: '15',
            epoch: HARNESS_PROCESS_EPOCH
        });

        const persisted = (source.snapshot().threads ?? []).find((record) => record.id === thread.id);

        expect(persisted?.invocationId).toBe('15');
        expect(persisted?.epoch).toBe(HARNESS_PROCESS_EPOCH);

        // Durable: the pair survives the restart, which is what lets the block and label planes tell two
        // runs of one id apart AFTER the process that minted it has ended.
        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);

        const restored = reloaded.threads().find((record) => record.id === thread.id);

        expect(restored?.invocationId).toBe('15');
        expect(restored?.epoch).toBe(HARNESS_PROCESS_EPOCH);
    });

    it('refuses an epoch that names no invocation id', () => {
        const base = coreOf();
        const thread = base.createThread('writer');

        base.setThreadStatus(thread.id, 'idle', '15');

        const document = JSON.parse(JSON.stringify(base.snapshot())) as {
            threads: Record<string, unknown>[];
        };

        delete document.threads[0].invocationId;

        const target = coreOf();

        // An epoch describes a RUN; with no id beside it there is no run, and a reader that accepted the
        // pair-half would write a key the next projection has to drop (../core/snapshot.ts:1006).
        expect(() => target.restore(document as never)).toThrow(
            'snapshot.threads[0].epoch requires an invocationId to identify a run (or must be absent).'
        );
    });
});
