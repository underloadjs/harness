// summarizeSessionUsage tests: the harness dialog's aggregate line.

// Four totals for ONE harness across EVERY session it owns, with the two rules that
// are easy to get wrong pinned exactly:
//   - thread counting is PER SESSION and summed, because the default conversation id
//     (`agent:instruct`) repeats in every session — a global union would collapse two
//     sessions into one thread;
//   - an unreported figure is `undefined`, never a fabricated 0, because the provider
//     decides whether usage/cache exists at all (HarnessUsage / HarnessUsage.cached).
//
// T33 adds the third rule the lazy directory depends on, pinned exactly:
//   - a row is DETAILED when `turns` is an array (even an empty one), AGGREGATE when
//     `turns` is absent and the caller supplied the session's server fold, and
//     PENDING when it is absent with nothing supplied. Those three are counted in
//     `unloaded` / `aggregate` / `pending`, all omitted when zero so a fully detailed
//     directory still returns exactly the old shape;
//   - a summary row NEVER fabricates tokens, cache or time, and `pending > 0` means a
//     figure is missing because it was not fetched — not because the provider was
//     silent, which is the `turns: []` case below.
//
// Run (focused): npx vitest run --config src/frontend/vitest.config.ts ui/usage-summary.test.ts
// Run (all UI):  npx vitest run --config src/frontend/vitest.config.ts
import { summarizeSessionUsage } from './usage-summary';
import type { UsageSession } from './usage-summary';
import type { SessionSnapshot, SessionTurn } from '../../server/protocol';
import type { SessionViewSummary } from '../view-model';

// Compile-time proof the parameter still accepts the two shapes the frontend actually
// holds: the raw `SessionSnapshot` (the `/api` surface and the legacy fixtures) and
// the windowed `SessionViewSummary` (the directory `main.ts` caches after T5 R1).
const consumerShapes: UsageSession[] = [{} as SessionSnapshot, {} as SessionViewSummary];
void consumerShapes;

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

    // --- T33: the lazy directory row (no turn history) ------------------------
    //
    // `GET /sessions` and the embedded bootstrap row publish `SessionSummary`
    // (shared/harness-api.ts:812): metadata + `turn_count`/`thread_count`, and
    // DELIBERATELY no turns, no roster, no display trees. The crash this pins: the
    // totals helper used to walk `session.turns` unguarded, so a directory of these
    // rows threw inside the details dialog, the pill strip and the header cycler.
    //
    // Extra row fields (`turn_count`, `revision`, …) stay outside `UsageSession` on
    // purpose — the helper reads counters and ids, and a row may carry anything else.
    const summaryRow = (overrides: Record<string, unknown> = {}) => ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        created_at: 1,
        updated_at: 2,
        turn_count: 4,
        thread_count: 2,
        revision: 7,
        ...overrides
    });

    it('totals a summary-only directory row without crashing and invents no figures', () => {
        // Threads still come from the server's own counter; tokens/cache/time stay
        // absent because nothing about this conversation was fetched, and the row is
        // counted so the caller knows the total is not turn-derived.
        expect(summarizeSessionUsage([summaryRow()])).toEqual({
            threads: 2,
            sessions: 1,
            unloaded: 1,
            pending: 1
        });
    });

    it('marks a row pending when neither history nor an aggregate is present', () => {
        const summary = summarizeSessionUsage([summaryRow(), summaryRow({ id: 's2' })]);

        // `'input' in summary === false` is the "unknown" signal; `pending` is what
        // separates it from a provider that answered and reported nothing.
        expect(summary).toEqual({ threads: 4, sessions: 2, unloaded: 2, pending: 2 });
        expect('input' in summary).toBe(false);
        expect('durationMs' in summary).toBe(false);
        // No aggregate was supplied, so the aggregate counter is omitted entirely.
        expect('aggregate' in summary).toBe(false);
    });

    it('treats a loaded-but-empty turn window as unreported, never pending', () => {
        // The contrast the dialog needs: `turns: []` is a real read over a
        // conversation with no turns, so the figures are absent because the provider
        // never reported them — the source-state keys must stay omitted.
        expect(summarizeSessionUsage([session({ turns: [] })])).toEqual({ threads: 0, sessions: 1 });

        // A `null` window (a legacy row) is the unloaded state, not an empty one.
        expect(summarizeSessionUsage([{ ...session(), turns: null as unknown as [] }])).toEqual({
            threads: 0,
            sessions: 1,
            unloaded: 1,
            pending: 1
        });
    });

    it('takes token totals from a supplied per-session usage aggregate', () => {
        // The lazy `GET /sessions/{id}/usage` fold (view-api.ts `readUsage`), i.e.
        // `SessionUsageResponse.usage`. No turn history was downloaded, and the
        // token figures are still exact.
        const row = { ...summaryRow(), usage: { input: 40_000, output: 120, total: 40_120, cached: 8_000 } };

        expect(summarizeSessionUsage([row])).toEqual({
            threads: 2,
            sessions: 1,
            input: 40_000,
            cached: 8_000,
            // No `durationMs`: the `/usage` fold publishes tokens only, so a summary
            // row leaves time unknown instead of reporting 0ms.
            unloaded: 1,
            aggregate: 1
        });
    });

    it('keeps a malformed aggregate not-reported but still counts it as aggregate', () => {
        // `usageOf` refuses a tally with no `total`, and the row was still FETCHED —
        // so it must not be reported as pending work for the caller to retry.
        const row = { ...summaryRow(), usage: { input: 500, output: 5 } as unknown as UsageSession['usage'] };

        expect(summarizeSessionUsage([row])).toEqual({
            threads: 2,
            sessions: 1,
            unloaded: 1,
            aggregate: 1
        });
    });

    it('adds a caller-measured duration for a summary row and drops an unusable one', () => {
        const measured = {
            ...summaryRow(),
            usage: { input: 10, output: 1, total: 11 },
            durationMs: 4_500
        };

        expect(summarizeSessionUsage([measured])).toEqual({
            threads: 2,
            sessions: 1,
            input: 10,
            durationMs: 4_500,
            unloaded: 1,
            aggregate: 1
        });

        // A non-finite measurement is dropped like an unusable span would be, so the
        // figure stays absent rather than becoming NaN.
        expect(summarizeSessionUsage([{ ...measured, durationMs: Number.NaN }]).durationMs).toBeUndefined();
    });

    it('sums an aggregate row and a detailed walk in one total', () => {
        // The realistic mixed directory: the open conversation holds its turn window,
        // the rest are compact rows the reader never opened.
        const detailed = session({
            turns: [
                turn({
                    id: 't1',
                    threadId: 'agent:instruct',
                    startedAt: T,
                    updatedAt: T + 1_000,
                    usage: { input: 9_935, output: 40, total: 9_975, cached: 1_472 }
                })
            ]
        });
        const row = {
            ...summaryRow({ id: 's2' }),
            usage: { input: 1_000, output: 5, total: 1_005 }
        };

        expect(summarizeSessionUsage([detailed, row])).toEqual({
            // 1 named conversation in the detailed row + the 2 the row's counter names.
            threads: 3,
            sessions: 2,
            input: 10_935,
            cached: 1_472,
            durationMs: 1_000,
            unloaded: 1,
            aggregate: 1
        });
    });

    it('counts threads from the windowed render model roster (threadViews)', () => {
        // `SessionView.threadViews` is the roster spelling on the display wire; the
        // per-session union rule is unchanged, so `host/a` counts once from either.
        const view = {
            threadViews: [{ id: 'host/a' }, { id: 'agent:instruct' }],
            turns: [turn({ id: 't1', threadId: 'host/a' })]
        };

        expect(summarizeSessionUsage([view])).toEqual({ threads: 2, sessions: 1, durationMs: 1_000 });
    });

    it('trusts a larger server counter over a windowed roster and never a smaller one', () => {
        // A windowed document holds one roster page (`ROSTER_PAGE_LIMIT`,
        // view-api.ts:121), so the union is a LOWER bound there and `threadCount` is
        // the honest figure. `thread_count` is the same counter on a raw row.
        const windowed: UsageSession = {
            ...session({
                threads: [
                    { id: 'host/a', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, messages: [] }
                ],
                turns: [turn({ id: 't1', threadId: 'agent:instruct' })]
            }),
            // The counter a directory/windowed row carries (`SessionView.threadCount`,
            // set by view-shell.ts `listViews` from `SessionSummary.turn/thread_count`).
            threadCount: 30
        };

        expect(summarizeSessionUsage([windowed])).toEqual({ threads: 30, sessions: 1, durationMs: 1_000 });

        // The other direction: two conversations this client can name, and a row that
        // under-counts them, still reports 2 — the counter never lowers a real total.
        const named: UsageSession = {
            ...session({
                threads: [
                    { id: 'host/a', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, messages: [] },
                    { id: 'host/b', agent: 'worker', origin: 'host', status: 'idle', sequence: 2, messages: [] }
                ],
                turns: []
            }),
            threadCount: 0
        };

        expect(summarizeSessionUsage([named])).toEqual({ threads: 2, sessions: 1 });
    });

    it('does not mutate a summary row or its supplied aggregate', () => {
        const row = {
            ...summaryRow(),
            usage: { input: 40_000, output: 120, total: 40_120, cached: 8_000 },
            durationMs: 1_000
        };
        const before = JSON.stringify(row);

        summarizeSessionUsage([row]);

        expect(JSON.stringify(row)).toBe(before);
    });
});
