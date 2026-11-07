// Build identity shown by the topbar brand: "Harness UI v2.3.0(081345)".
//
// WHY THIS IS COMPUTED AT BUILD TIME (src/frontend/vite.config.ts), NOT HERE:
// the label names the ARTIFACT that was deployed. The package version lives in
// package.json (not reachable from the browser bundle) and the stamp must be
// the moment the build ran — a `new Date()` in the browser would print the
// VISITOR's clock and drift away from the deployed artifact, and a local build
// could disagree with the Pages build. So vite.config.ts composes the label
// once per build and inlines it as `__HARNESS_UI_LABEL__`.
//
// This module stays pure so the format is testable with a pinned timestamp
// (build-label.test.ts) instead of freezing the clock.
//
// NOT THE PACKAGE VERSION'S SOURCE OF TRUTH: the `version` field is; this only
// formats it. Nor is it the harness SNAPSHOT version (src/core/snapshot.ts),
// which numbers the on-disk state format and is unrelated to releases.

/**
 * Two-digit day, hour and minute (DDHHMM) of the machine running the build:
 * 2026-11-24 09:05 -> "240905".
 *
 * DDHHMM names the BUILD, not the calendar date: it is unique per minute
 * within a day, but two builds at the same time on the 8th of different months
 * look identical. That is the intended reading of "day, hour, minute".
 *
 * Reads the LOCAL clock, i.e. "now" on the build host. GitHub Actions runners
 * are UTC, so a CI build stamps the UTC day and time of the run; a local build
 * stamps the developer's local clock.
 */
export const formatBuildStamp = (date: Date): string => {
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${day}${hour}${minute}`;
};

/** The label shape: `Harness UI v<package version>(<build stamp>)`. */
export const formatHarnessUiLabel = (version: string, stamp: string): string =>
    `Harness UI v${version}(${stamp})`;
