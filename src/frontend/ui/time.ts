// Elapsed-time formatting and safe duration arithmetic.
//
// Durations come from three places and must render the same everywhere:
//   - a live local clock while a turn or tool call runs;
//   - the server's `startedAt`/`updatedAt` on hydration;
//   - `eventTimes` offsets for individual tool calls on hydration.
//
// A missing, negative, or non-finite span is `undefined` — the caller prints
// nothing rather than "NaN". That is the graceful fallback for fixtures recorded
// before the server sent timing data.
//
// Cross-references:
//   - src/frontend/ui/turns.ts — turn elapsed label and per-call durations
//   - src/frontend/ui/tools.ts — tool duration in the summary line

// Format a non-negative duration. Deterministic on purpose (tests assert exact
// text): <1s in whole milliseconds, <1min in tenths of a second, otherwise minutes
// plus zero-padded seconds with NO separator between the units (R4: `4m12s`).
export const formatDuration = (milliseconds: number): string => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';

    const rounded = Math.round(milliseconds);
    if (rounded < 1000) return `${rounded}ms`;

    if (rounded < 60_000) return `${(rounded / 1000).toFixed(1)}s`;

    const seconds = Math.floor(rounded / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;

    return `${minutes}m${String(rest).padStart(2, '0')}s`;
};

// --- Liveness presentation thresholds (T3 frontend liveness honesty) ----------
//
// A model composing a TOOL CALL emits no content at all: the transport's content yields
// are only the delta pair (../../transport/openai.ts:1952-1956) plus the counter-only
// `progress` heartbeat (:1983-1989); `HarnessStreamEvent` still has no tool frame
// (../../types/index.ts:495-522), and the UI's first frame about a call is the post-`done`
// `tool_call` (../../harness.ts:10887). A 60s silent request and a dead stream produced the
// SAME pixels — these thresholds tell them apart from signals this view already carries.
//
// THEY ARE PRESENTATION THRESHOLDS, NOT TIMEOUTS. Nothing in this project ends a
// run on a wall clock — the documented policy is that no external clock kills a run
// (knowledge.md:5205-5209); the only real bounds are the provider idle bounds in
// ../transport/provider-timeouts.ts. Crossing these numbers changes only what the UI
// is allowed to SAY about a run that is still running.
//
//   < QUIET_AFTER_MS   — frames are arriving; the normal live affordances apply.
//   QUIET .. SILENT    — the run is live and the UI has heard nothing for a while.
//   >= SILENT_AFTER_MS — a long silence: the same fact, phrased plainly.
export const QUIET_AFTER_MS = 5_000;
export const SILENT_AFTER_MS = 30_000;

export type QuietGrade = 'quiet' | 'silent';

// Grade an age since "the last thing the UI received", or undefined while the view
// still honestly reads as live. An undefined/non-finite age means "unknown" (a turn
// that never received a frame, or a record with no stamps): NOT quiet, because a
// claim of silence needs a stamp to measure from. A negative age (a server clock
// running ahead of the local one, or a frame the caller had already timed newer) is
// a FRESH frame, never a silent one.
export const quietGradeOf = (ageMs: number | undefined): QuietGrade | undefined => {
    if (ageMs === undefined || !Number.isFinite(ageMs)) return undefined;
    if (ageMs < QUIET_AFTER_MS) return undefined;

    return ageMs >= SILENT_AFTER_MS ? 'silent' : 'quiet';
};

// Difference between two epoch-millisecond stamps, or undefined when either side
// is missing or the clock went backwards. Never NaN.
export const elapsedBetween = (start: unknown, end: unknown): number | undefined => {
    if (typeof start !== 'number' || typeof end !== 'number') return undefined;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    if (end < start) return undefined;

    return end - start;
};

// Convenience for markup: undefined when there is nothing honest to show.
export const formatElapsed = (start: unknown, end: unknown): string | undefined => {
    const span = elapsedBetween(start, end);
    return span === undefined ? undefined : formatDuration(span);
};
