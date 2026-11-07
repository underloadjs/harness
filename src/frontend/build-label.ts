// Build identity shown by the topbar brand: "Harness UI v2.3.0(261108)".
//
// WHY THIS IS COMPUTED AT BUILD TIME (src/frontend/vite.config.ts), NOT HERE:
// the label names the ARTIFACT that was deployed. The package version lives in
// package.json (not reachable from the browser bundle) and "today" must be the
// day the build ran — a `new Date()` in the browser would print the VISITOR's
// date and drift away from the deployed artifact, and a local build could
// disagree with the Pages build. So vite.config.ts composes the label once per
// build and inlines it as `__HARNESS_UI_LABEL__`.
//
// This module stays pure so the format is testable with a pinned date
// (build-label.test.ts) instead of freezing the clock.
//
// NOT THE PACKAGE VERSION'S SOURCE OF TRUTH: the `version` field is; this only
// formats it. Nor is it the harness SNAPSHOT version (src/core/snapshot.ts),
// which numbers the on-disk state format and is unrelated to releases.

/**
 * Two-digit year, month and day (YYMMDD) of the machine running the build:
 * 2026-11-24 -> "261124".
 *
 * Reads the LOCAL calendar fields, i.e. "today" on the build host. GitHub
 * Actions runners are UTC, so a CI build stamps the UTC day of the run; a local
 * build stamps the developer's local day. That is the intended reading of
 * "today's date" and avoids a build at 00:30 showing yesterday.
 */
export const formatBuildStamp = (date: Date): string => {
    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
};

/** The label shape: `Harness UI v<package version>(<build stamp>)`. */
export const formatHarnessUiLabel = (version: string, stamp: string): string =>
    `Harness UI v${version}(${stamp})`;
