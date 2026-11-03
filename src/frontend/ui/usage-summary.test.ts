// summarizeSessionUsage tests: the harness dialog's aggregate line.

// Four totals for ONE harness across EVERY session it owns, with the two rules that
// are easy to get wrong pinned exactly:
//   - thread counting is PER SESSION and summed, because the default conversation id
//     (`agent:instruct`) repeats in every session — a global union would collapse two
//     sessions into one thread;
//   - an unreported figure is `undefined`, never a fabricated 0, because the provider
//     decides whether usage/cache exists at all (HarnessUsage / HarnessUsage.cached).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import { summarizeSessionUsage } from './usage-summary';
import type { SessionSnapshot, SessionTurn } from '../../server/protocol';

const T = 1_700_000_000_000;

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'hello',
        status: 'done',
        startedAt: T,
        updatedAt: T + 1_000,
        events: [],
        ...overrides
    }) as SessionTurn;

const session = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

describe('summarizeSessionUsage', () => {
    it('totals an empty directory as zero sessions and no reported figures', () => {
        // No conversations at all: `sessions: 0` is what tells the caller to omit the
        // row instead of printing a line of zeros, and every optional figure stays
        // absent rather than becoming 0.
        expect(summarizeSessionUsage([])).toEqual({ threads: 0, sessions: 0 });
    });

    it('sums thread counts PER session instead of unioning ids globally', () => {
        // The exact bug: both sessions run their turn in the SAME default conversation
        // id, so a global Set would report 1 thread for two sessions.
        const first = session({ turns: [turn({ threadId: 'agent:instruct' })] });
        const second = session({ id: 's2', turns: [turn({ id: 't9', threadId: 'agent:instruct' })] });

        expect(summarizeSessionUsage([first, second])).toEqual({
            threads: 2,
            sessions: 2,
            durationMs: 2_000
        });
    });

    it('unions a session host roster with its turn thread ids, counting each once', () => {
        const only = session({
            // `host/main` also appears as a turn id, and `turns t1`/`t2` share a
            // conversation, so the session owns exactly three distinct threads.
            threads: [
                { id: 'host/main', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, messages: [] },
                { id: 'host/other', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2, messages: [] }
            ],
            turns: [
                turn({ id: 't1', threadId: 'agent:instruct' }),
                turn({ id: 't2', threadId: 'agent:instruct' }),
                turn({ id: 't3', threadId: 'host/main' })
            ]
        });

        expect(summarizeSessionUsage([only])).toEqual({ threads: 3, sessions: 1, durationMs: 3_000 });
    });

    it('counts 0 threads for a legacy session with no roster and no turn thread ids', () => {
        // A `/messages` turn omits `threadId`, and `threads` is omitted when the
        // session owns no host thread. There is genuinely no conversation to name, and
        // `0` is a real answer — unlike the token figures below.
        expect(summarizeSessionUsage([session({ turns: [turn()] })])).toEqual({
            threads: 0,
            sessions: 1,
            durationMs: 1_000
        });
    });

    it('sums input tokens over the turns that report usage', () => {
        const one = session({
            turns: [
                turn({ id: 't1', usage: { input: 100, output: 5, total: 105 } }),
                turn({ id: 't2', usage: { input: 49_835, output: 100, total: 49_935 } })
            ]
        });
        const two = session({
            id: 's2',
            turns: [turn({ id: 't3', usage: { input: 1_000, output: 0, total: 1_000 } })]
        });

        expect(summarizeSessionUsage([one, two])).toEqual({
            threads: 0,
            sessions: 2,
            input: 50_935,
            durationMs: 3_000
        });
    });

    it('omits input entirely when no turn reports usage', () => {
        // The provider never answered a tally: "unknown", not "spent nothing".
        expect(summarizeSessionUsage([session({ turns: [turn()] })]).input).toBeUndefined();
        expect('input' in summarizeSessionUsage([session({ turns: [turn()] })])).toBe(false);
    });

    it('treats a malformed tally as not reported', () => {
        // `usageOf` (contract.ts) refuses a partially malformed block — an absent
        // `total` here — so it must not contribute a half-sum to the total.
        const broken = session({
            turns: [turn({ id: 't1', usage: { input: 500, output: 5 } as unknown as SessionTurn['usage'] })]
        });

        expect(summarizeSessionUsage([broken])).toEqual({ threads: 0, sessions: 1, durationMs: 1_000 });
    });

    it('sums only the reported cache figures and never invents zero', () => {
        // Turn 1 reported a cache figure, turn 2 reported input only. The total cache
        // is 9_472 (not 9_472 + 0, and not "unknown"): a turn that said nothing about
        // its cache contributes nothing.
        const mixed = session({
            turns: [
                turn({ id: 't1', usage: { input: 10_000, output: 5, total: 10_005, cached: 9_472 } }),
                turn({ id: 't2', usage: { input: 1_000, output: 5, total: 1_005 } })
            ]
        });

        expect(summarizeSessionUsage([mixed])).toEqual({
            threads: 0,
            sessions: 1,
            input: 11_000,
            cached: 9_472,
            durationMs: 2_000
        });
    });

    it('reports a cache total of 0 when a provider says nothing was cached', () => {
        // `cached: 0` is a real answer, so the figure exists and is exactly 0.
        const zero = session({
            turns: [turn({ id: 't1', usage: { input: 10, output: 1, total: 11, cached: 0 } })]
        });

        expect(summarizeSessionUsage([zero]).cached).toBe(0);
    });

    it('omits the cache figure when no turn reported one', () => {
        const none = session({
            turns: [turn({ id: 't1', usage: { input: 10, output: 1, total: 11 } })]
        });

        expect(summarizeSessionUsage([none])).toEqual({
            threads: 0,
            sessions: 1,
            input: 10,
            durationMs: 1_000
        });
    });

    it('totals completed run time over terminal turns only', () => {
        // done 4m0s + cancelled 10s + error 1s are all finished runs. `running` is
        // excluded because its `updatedAt` is a heartbeat, and `queued` has no start
        // stamp at all — including them would inflate a total that is supposed to be
        // settled history.
        const live = session({
            turns: [
                turn({ id: 't1', status: 'done', startedAt: T, updatedAt: T + 240_000 }),
                turn({ id: 't2', status: 'cancelled', startedAt: T, updatedAt: T + 10_000 }),
                turn({ id: 't3', status: 'error', startedAt: T, updatedAt: T + 1_000 }),
                turn({ id: 't4', status: 'running', startedAt: T, updatedAt: T + 900_000 }),
                turn({ id: 't5', status: 'queued', startedAt: undefined, updatedAt: T + 900_000 })
            ]
        });

        expect(summarizeSessionUsage([live])).toEqual({ threads: 0, sessions: 1, durationMs: 251_000 });
    });

    it('skips a terminal turn with no start stamp or a backwards clock', () => {
        const legacy = session({
            turns: [
                turn({ id: 't1', status: 'done', startedAt: undefined, updatedAt: T + 5_000 }),
                turn({ id: 't2', status: 'done', startedAt: T + 5_000, updatedAt: T }),
                turn({ id: 't3', status: 'done', startedAt: T, updatedAt: T + 2_500 })
            ]
        });

        expect(summarizeSessionUsage([legacy])).toEqual({ threads: 0, sessions: 1, durationMs: 2_500 });
    });

    it('omits the time figure when no turn has a usable span', () => {
        const noTimes = session({ turns: [turn({ id: 't1', startedAt: undefined })] });

        expect(summarizeSessionUsage([noTimes])).toEqual({ threads: 0, sessions: 1 });
    });

    it('adds a zero-length completed run without inventing the figure', () => {
        // `startedAt === updatedAt` is a measured zero, so the total EXISTS as 0 —
        // the caller then prints `0ms` rather than hiding the figure.
        const instant = session({ turns: [turn({ startedAt: T, updatedAt: T })] });

        expect(summarizeSessionUsage([instant]).durationMs).toBe(0);
    });

    it('does not mutate the snapshots it walks', () => {
        const first = session({
            turns: [turn({ id: 't1', usage: { input: 10, output: 1, total: 11, cached: 4 } })]
        });
        const before = JSON.stringify(first);

        summarizeSessionUsage([first]);

        expect(JSON.stringify(first)).toBe(before);
    });

    it('totals every figure together for a realistic two-session harness', () => {
        // The shape the dialog renders: two sessions of one harness, each with its own
        // default conversation plus a delegated child in the second one.
        const first = session({
            turns: [
                turn({
                    id: 't1',
                    threadId: 'agent:instruct',
                    startedAt: T,
                    updatedAt: T + 62_000,
                    usage: { input: 40_000, output: 120, total: 40_120, cached: 8_000 }
                })
            ]
        });
        const second = session({
            id: 's2',
            threads: [
                { id: 'host/worker', agent: 'worker', origin: 'host', status: 'stopped', sequence: 1, messages: [] }
            ],
            turns: [
                turn({
                    id: 't2',
                    index: 0,
                    threadId: 'agent:instruct',
                    startedAt: T,
                    updatedAt: T + 30_000,
                    usage: { input: 9_935, output: 40, total: 9_975, cached: 1_472 }
                }),
                turn({
                    id: 't3',
                    index: 1,
                    threadId: 'host/worker',
                    startedAt: T,
                    updatedAt: T + 5_000,
                    usage: { input: 2_000, output: 10, total: 2_010 }
                })
            ]
        });

        expect(summarizeSessionUsage([first, second])).toEqual({
            // 1 thread in s1 + 2 distinct threads in s2 (`host/worker` is in the roster
            // AND on a turn, so it counts once).
            threads: 3,
            sessions: 2,
            input: 51_935,
            cached: 9_472,
            durationMs: 97_000
        });
    });
});
