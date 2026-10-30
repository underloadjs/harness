// Harness-level app tools — the stable catalogue surface.
//
// R2 (task-harness-self-modifying-tools): each tool now has an independently
// compilable, editable source entry under ./tool-sources/. This file only composes
// those entries into the app catalogue; it contains no tool implementation itself.
// Replacing one tool therefore never requires rebuilding the harness or unrelated
// tools, and an agent can inspect/edit the exact entry that produced the
// registered definition.
//
// SOURCE ENTRY POINTS (one Tool default export each):
//   ./tool-sources/timeNow.ts
//   ./tool-sources/textCount.ts
//   ./tool-sources/diceRoll.ts
//   ./tool-sources/noteSearch.ts
//   ./tool-sources/textSummarize.ts
//   ./tool-sources/testFlaky.ts
//
// These are ordinary `tool()` definitions executed by the server; they were
// deliberately dependency-free so the catalogue stays useful without an endpoint,
// and they show the discovery flow: every one is searchable, so a model must call
// toolRequest before it can use one.
//
// NAMING (T14): `<namespace><action>` — timeNow, textCount, diceRoll, noteSearch,
// textSummarize, testFlaky. The old names (clock, wordCount, roll, searchNotes,
// summarize, flaky) are gone with no aliases; a second name for one tool would make
// discovery ambiguous.
//
// Cross-references:
//   - ./tool-sources/*   — the independently editable definitions
//   - ./toolbox.ts       — the shared live toolbox (excludes testFlaky)
//   - ./index.ts         — createToolCatalogue() groups these as 'Harness tools'
//   - ../../harness.ts   — `tool()` and the live ToolContext (`agent`, `run`, …)
//   - ../../types        — Tool contract required of every source entry

import type { Tool } from '../../harness';
import timeNow from './tool-sources/timeNow';
import textCount from './tool-sources/textCount';
import diceRoll from './tool-sources/diceRoll';
import noteSearch from './tool-sources/noteSearch';
import textSummarize from './tool-sources/textSummarize';
import testFlaky from './tool-sources/testFlaky';

// The harness-level catalogue, keyed by the name the model calls. Package presets
// live in `src/tools`; these are the extras that need no Node built-ins.
export const harnessTools = {
    timeNow,
    textCount,
    diceRoll,
    noteSearch,
    textSummarize,
    testFlaky
} satisfies Readonly<Record<string, Tool>>;
