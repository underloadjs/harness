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
