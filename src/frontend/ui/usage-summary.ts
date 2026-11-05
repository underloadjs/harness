// Aggregate usage for a harness ACROSS all of its sessions.
//
// The harness details dialog shows one compact line (`6 threads · 49,935 input ·
// 1h 2m · 9,472 cache`) for the SAME set of conversations the session-chip strip
// lists, so the figures can never disagree with the chips (`main.ts` builds both
// from `sessionDirectory()`).
//
// Derivation rules (deliberately per session, not global):
//   - `threads` — per session, the UNION of the roster ids (`threads` on a raw
//     snapshot, `threadViews` on the windowed render model) plus every
//     `turn.threadId` (the persistent conversation each turn ran in), then the
//     per-session sizes are SUMMED. A global union is wrong: the default
//     conversation id (`agent:instruct`) repeats in every session of one harness and
//     would collapse N sessions into one thread. See protocol.ts `SessionSnapshot`
//     (R1-R6: `threads` is present ONLY when the session owns a host thread, so the
//     turn ids are what makes the default conversation countable). A row that also
//     carries the server's own counter wins when it is LARGER, because a windowed
//     document holds at most one roster page (`ROSTER_PAGE_LIMIT`, view-api.ts:121),
//     so the union is a lower bound there and never an overcount.
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
// THREE SOURCE STATES, kept distinct on purpose (T33): the directory is now a lazy,
// compact projection, so a row is not always a conversation in full. The helper never
// invents a figure for a row it cannot see, and it never reports "not fetched yet"
// as "the provider never said":
//   1. DETAILED  — `turns` is an array (possibly empty). Every figure comes from the
//      turn walk above. An empty array is a real answer: the conversation has no
//      turns, so a figure is UNREPORTED, not pending.
//   2. AGGREGATE — `turns` is absent (a `SessionSummary` directory row whose history
//      was never downloaded) and the caller supplied this session's server-computed
//      tally (`GET /sessions/{id}/usage` → `SessionUsageResponse.usage`, surfaced by
//      view-api.ts `readUsage`). The token figures come from that fold, which uses
//      the same honesty rules server-side, so no turn history has to be downloaded.
//   3. PENDING   — `turns` is absent and no aggregate was supplied. The row
//      contributes NOTHING to the token/cache/time totals, and it is counted in
//      `pending` so the caller can lazy-fetch the aggregate instead of painting a
//      total that quietly ignores a conversation.
// `unloaded` counts 2 + 3 (rows whose totals are not turn-derived); `aggregate`
// counts 2; `pending` counts 3. All three are OMITTED when zero, so a fully detailed
// directory reads exactly as it did before. Threads stay computable in every state
// because a directory row carries the server's own `thread_count`/`threadCount`.
//
// Nothing is mutated: every input is walked read-only, so the caller's cached
// snapshots stay usable for the pills and the transcript.
//
// Cross-references:
//   - src/frontend/main.ts         — `harnessDetailsBody` / `paintHarnessDialogStats`
//   - src/frontend/contract.ts     — `usageOf`, the wire validation this reuses
//   - src/frontend/view-api.ts     — `readUsage`, the lazy per-session aggregate
//   - src/frontend/view-model.ts   — `SessionView`/`SessionViewSummary` (`threadViews`)
//   - src/shared/harness-api.ts    — `SessionSummary` (row counters), `SessionUsageResponse`
//   - src/frontend/ui/time.ts      — `elapsedBetween`, the same span arithmetic
//   - src/frontend/ui/tokens.ts    — `formatTokens`, the display formatter
//   - src/server/protocol.ts       — SessionSnapshot / SessionTurn / SessionThread

import type { HarnessUsage } from '../../types';
import { usageOf } from '../contract';
import { elapsedBetween } from './time';

// One turn as the totals helper needs it: STATUS, timing stamps, the conversation id
// and the tally — never `events`/`displays`, which is what keeps the totals cheap.
// Both `SessionTurn` (raw wire) and `TurnSummary` (the display rows a windowed
// document holds) satisfy this structurally.
export type UsageTurn = {
    status: string;
    updatedAt: number;
    startedAt?: number;
    threadId?: string;
    usage?: HarnessUsage;
};

// A session as the totals helper needs it. Every directory shape satisfies it — the
// display wire's `SessionViewSummary`, the raw `SessionSnapshot`, the windowed
// `SessionView` and a compact `SessionSummary` row — because the totals read header
// counters, roster ids and turn STATUS/USAGE only, never `events` (T5 R1).
export type UsageSession = {
    // Host roster as the RAW snapshot spells it (`SessionSnapshot.threads`), omitted
    // entirely when the session owns no host thread.
    threads?: readonly { id: string }[];
    // The same roster on the windowed render model (`SessionView.threadViews`),
    // omitted when the roster page has not been read.
    threadViews?: readonly { id: string }[];
    // PRESENT (even empty) = the turn history is loaded, so a missing figure is a
    // provider answer. ABSENT = a summary row; see the three states in the header.
    turns?: readonly UsageTurn[];
    // The server's own conversation counter, in both spellings the frontend meets:
    // camelCase after the view-api rename, snake_case on a raw `SessionSummary` row
    // (the bootstrap document embeds those verbatim, main.ts `refreshSessions`).
    threadCount?: number;
    thread_count?: number;
    // State 2: this session's server-computed tally, from the lazy
    // `GET /sessions/{id}/usage` fold. Supplied only when that read ANSWERED — a
    // caller that has not asked leaves it absent so the row stays `pending`.
    usage?: HarnessUsage;
    // A caller-measured completed-time figure for a summary row. The `/usage` fold
    // publishes tokens only, so a summary-only directory leaves `durationMs`
    // unknown rather than 0; this exists for a caller that has a real measurement.
    durationMs?: number;
};

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
    // State 2 + 3: sessions whose turn history is NOT loaded, so their token figures
    // did not come from a turn walk. Omitted when every session is detailed.
    unloaded?: number;
    // State 2: sessions whose figures came from a supplied server aggregate. Omitted
    // when none did, so the caller can tell a mixed total from a pure walk.
    aggregate?: number;
    // State 3: sessions with neither history nor aggregate. A figure that is absent
    // while this is non-zero means "not fetched yet", NOT "the provider never
    // reported one" — the caller's cue to lazy-read `readUsage` for those ids.
    pending?: number;
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

// A usable server counter. A directory row that never published one (an older
// server, or a raw snapshot) resolves to undefined and the union stands alone.
const counterOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

// The turn history THIS row carries when it is loaded, otherwise undefined (= a
// summary row). `Array.isArray` rather than `!== undefined` because a legacy row may
// carry `turns: null`, which is the same fact: nothing to walk. An empty array is
// NOT treated as unloaded — it is a loaded window over a conversation with no turns.
const loadedTurns = (session: UsageSession): readonly UsageTurn[] | undefined =>
    Array.isArray(session.turns) ? session.turns : undefined;

// Union the ids THIS session can name (host roster + the conversations its turns ran
// in) and return how many distinct ones there are.
const countSessionThreads = (session: UsageSession): number => {
    const ids = new Set<string>();

    // Both roster spellings, defensively: a raw snapshot uses `threads`, the
    // windowed document uses `threadViews`, and a summary row carries neither.
    for (const thread of session.threads ?? session.threadViews ?? []) {
        const id = threadIdOf(thread.id);
        if (id !== undefined) ids.add(id);
    }

    // A turn's `threadId` is omitted for a legacy `/messages` record, which is the
    // one case where a conversation genuinely cannot be named.
    for (const turn of session.turns ?? []) {
        const id = threadIdOf(turn.threadId);
        if (id !== undefined) ids.add(id);
    }

    // The server's own counter is authoritative whenever it knows MORE than this
    // client can name: a windowed document holds one roster page (25 rows) and one
    // turn page, so a 40-conversation conversation names at most 25 + its turn ids.
    // Taking the larger figure keeps the total honest instead of quietly short.
    const counter = Math.max(
        counterOf(session.threadCount) ?? 0,
        counterOf(session.thread_count) ?? 0
    );

    return Math.max(ids.size, counter);
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
    turn: UsageTurn,
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

// Fold one session into the totals and report which source state it used, so the
// caller can distinguish a provider that stayed silent from history not fetched.
type SourceKind = 'detailed' | 'aggregate' | 'pending';

const accumulateSession = (
    session: UsageSession,
    totals: { input?: number; cached?: number; durationMs?: number }
): SourceKind => {
    const turns = loadedTurns(session);
    if (turns !== undefined) {
        for (const turn of turns) accumulateTurn(turn, totals);

        return 'detailed';
    }

    // State 3: no history and no supplied aggregate — the row contributes nothing,
    // and saying so is the whole point (an absent figure keeps its meaning).
    if (session.usage === undefined) return 'pending';

    // State 2: the server already folded this session's turns. Same wire validation
    // as a turn tally, so a malformed aggregate is "not reported" rather than a
    // half-sum, and `cached` stays its own unknown.
    const usage = usageOf(session.usage);
    if (usage !== undefined) {
        totals.input = add(totals.input, usage.input);
        if (usage.cached !== undefined) totals.cached = add(totals.cached, usage.cached);
    }

    // Tokens aside, time is only knowable from turn stamps (or a caller measurement);
    // a non-finite/negative measurement is dropped like an unusable span would be.
    const measured = counterOf(session.durationMs);
    if (measured !== undefined) totals.durationMs = add(totals.durationMs, measured);

    return 'aggregate';
};

// Sum the aggregate figures for the sessions of ONE harness. Insertion order is
// stable, so the caller's rendering is deterministic.
export const summarizeSessionUsage = (entries: readonly UsageSession[]): SessionUsageSummary => {
    const totals: { input?: number; cached?: number; durationMs?: number } = {};
    let threads = 0;
    let unloaded = 0;
    let aggregate = 0;
    let pending = 0;

    for (const session of entries) {
        threads += countSessionThreads(session);

        const source = accumulateSession(session, totals);
        if (source === 'detailed') continue;

        unloaded += 1;
        if (source === 'aggregate') aggregate += 1;
        else pending += 1;
    }

    // Optional keys are OMITTED when unknown rather than set to `undefined`, so a
    // `'input' in summary` check and an `undefined` read mean the same thing. The
    // three source counters are omitted when zero for the same reason: a fully
    // detailed directory returns exactly the shape it always did.
    return {
        threads,
        sessions: entries.length,
        ...(totals.input === undefined ? {} : { input: totals.input }),
        ...(totals.cached === undefined ? {} : { cached: totals.cached }),
        ...(totals.durationMs === undefined ? {} : { durationMs: totals.durationMs }),
        ...(unloaded === 0 ? {} : { unloaded }),
        ...(aggregate === 0 ? {} : { aggregate }),
        ...(pending === 0 ? {} : { pending })
    };
};
