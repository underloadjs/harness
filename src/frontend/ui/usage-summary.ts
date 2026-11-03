// Aggregate usage for a harness ACROSS all of its sessions.
//
// The harness details dialog shows one compact line (`6 threads · 49,935 input ·
// 1h 2m · 9,472 cache`) for the SAME set of conversations the session-chip strip
// lists, so the figures can never disagree with the chips (`main.ts` builds both
// from `sessionDirectory()`).
//
// Derivation rules (deliberately per session, not global):
//   - `threads` — per session, the UNION of `session.threads[].id` (host threads)
//     and every `turn.threadId` (the persistent conversation each turn ran in), then
//     the per-session sizes are SUMMED. A global union is wrong: the default
//     conversation id (`agent:instruct`) repeats in every session of one harness and
//     would collapse N sessions into one thread. See protocol.ts `SessionSnapshot`
//     (R1-R6: `threads` is present ONLY when the session owns a host thread, so the
//     turn ids are what makes the default conversation countable).
//   - `input`   — SUM of `turn.usage.input` over the turns that report usage at all.
//     `undefined` when no turn reports it: `HarnessUsage` is optional because the
//     provider decides whether usage exists, so absent is "unknown", never zero.
//   - `cached`  — SUM of the DEFINED `turn.usage.cached` values only. A turn whose
//     provider reported no cache figure contributes NOTHING (it does not contribute
//     0), and the figure is `undefined` when no turn reported one.
//   - `durationMs` — SUM of completed run time over TERMINAL turns only
//     (`status` is neither 'running' nor 'queued'), each measured with
//     `elapsedBetween(startedAt, updatedAt)`. A running/queued turn is excluded
//     because its `updatedAt` is a heartbeat, not an end stamp, and including it
//     would make the total grow while nothing is being measured. A turn with no
//     start stamp (legacy record) or a backwards clock contributes nothing.
//   - `sessions` — the entry count, so the caller can tell "no conversations" from
//     "conversations with nothing reported".
//
// Nothing is mutated: every input is walked read-only, so the caller's cached
// snapshots stay usable for the pills and the transcript.
//
// Cross-references:
//   - src/frontend/main.ts         — `harnessDetailsBody` / `paintHarnessDialogStats`
//   - src/frontend/contract.ts     — `usageOf`, the wire validation this reuses
//   - src/frontend/ui/time.ts      — `elapsedBetween`, the same span arithmetic
//   - src/frontend/ui/tokens.ts    — `formatTokens`, the display formatter
//   - src/server/protocol.ts       — SessionSnapshot / SessionTurn / SessionThread

import type { SessionSnapshot } from '../../server/protocol';
import { usageOf } from '../contract';
import { elapsedBetween } from './time';

export type SessionUsageSummary = {
    // Total conversations (threads) across every session. Always derivable, so it
    // is always shown — 0 is a real answer here, unlike the figures below.
    threads: number;
    // Total prompt tokens. Undefined when no turn in any session reported usage.
    input?: number;
    // Total input tokens the providers served from their prefix cache. Undefined
    // when no turn reported a cache figure (see HarnessUsage.cached).
    cached?: number;
    // Summed completed run time in milliseconds. Undefined when no terminal turn
    // carried a usable start/end pair.
    durationMs?: number;
    // How many sessions the totals cover.
    sessions: number;
};

// The two IN-FLIGHT turn states (protocol.ts SessionTurnStatus). Everything else in
// that union — 'done' | 'error' | 'cancelled' — is terminal, so listing the
// in-flight pair (rather than the terminal trio) keeps a future terminal status
// counted as completed instead of silently dropping out of the total.
const IN_FLIGHT: readonly string[] = ['queued', 'running'];

// A non-empty thread id. An empty/blank id is not a conversation, and counting one
// would inflate a total the reader cannot match to any pill or tile.
const threadIdOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;

// Union the ids THIS session owns (host roster + the conversations its turns ran in)
// and return how many distinct ones there are.
const countSessionThreads = (session: SessionSnapshot): number => {
    const ids = new Set<string>();

    // `threads` is omitted entirely when a session owns no host thread, hence `?? []`.
    for (const thread of session.threads ?? []) {
        const id = threadIdOf(thread.id);
        if (id !== undefined) ids.add(id);
    }

    // A turn's `threadId` is omitted for a legacy `/messages` record, which is the
    // one case where a conversation genuinely cannot be named.
    for (const turn of session.turns) {
        const id = threadIdOf(turn.threadId);
        if (id !== undefined) ids.add(id);
    }

    return ids.size;
};

// Add one reported figure to an accumulator that is still `undefined`. Doubles as
// the "nothing reported yet" flag: the sum only exists once something real was
// added, so an unknown total is never printed as `0`.
const add = (total: number | undefined, value: number): number =>
    total === undefined ? value : total + value;

const isTerminal = (status: string): boolean => !IN_FLIGHT.includes(status);

// Fold one turn into the running totals. Kept separate from the session walk so the
// per-figure "reported or not" rules stay in one place.
const accumulateTurn = (
    turn: SessionSnapshot['turns'][number],
    totals: { input?: number; cached?: number; durationMs?: number }
): void => {
    // Validate through the wire helper: a partially malformed tally is treated as
    // "not reported" rather than adding a half-sum (contract.ts usageOf).
    const usage = usageOf(turn.usage);
    if (usage !== undefined) {
        totals.input = add(totals.input, usage.input);
        // `cached` is its own unknown: a turn may report input with no cache figure,
        // and inventing 0 here would misreport a provider that never says.
        if (usage.cached !== undefined) totals.cached = add(totals.cached, usage.cached);
    }

    if (isTerminal(turn.status)) {
        // `elapsedBetween` already refuses missing, non-finite or backwards stamps,
        // so a legacy record or a clock jump simply contributes nothing.
        const span = elapsedBetween(turn.startedAt, turn.updatedAt);
        if (span !== undefined) totals.durationMs = add(totals.durationMs, span);
    }
};

// Sum the aggregate figures for the sessions of ONE harness. Insertion order is
// stable, so the caller's rendering is deterministic.
export const summarizeSessionUsage = (entries: readonly SessionSnapshot[]): SessionUsageSummary => {
    const totals: { input?: number; cached?: number; durationMs?: number } = {};
    let threads = 0;

    for (const session of entries) {
        threads += countSessionThreads(session);
        for (const turn of session.turns) accumulateTurn(turn, totals);
    }

    // Optional keys are OMITTED when unknown rather than set to `undefined`, so a
    // `'input' in summary` check and an `undefined` read mean the same thing.
    return {
        threads,
        sessions: entries.length,
        ...(totals.input === undefined ? {} : { input: totals.input }),
        ...(totals.cached === undefined ? {} : { cached: totals.cached }),
        ...(totals.durationMs === undefined ? {} : { durationMs: totals.durationMs })
    };
};
