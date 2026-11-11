# 0012 — the math-flattening disclosure is produced by the converter and dropped by `fetch`

> **Status:** Fixed — 2026-11-11 (**reduced 2026-11-11**: the `<sup>`/`<sub>` marker conversion in
> both passes, the `data-mw` attribute-metadata leak, and the converter's own report of the
> flattening landed first — see **Update (2026-11-11) — partially closed**; the last gap, the
> envelope hand-off in `src/tools/webfetch/index.ts`, closed the same day — see **Update
> (2026-11-11, fix) — closed** at the bottom). File kept for review — delete it and its index row
> once the owner's integrated run confirms.
> **Severity:** Significant
> **Area:** `src/tools/webfetch/index.ts` (the result envelope's `note`). The conversion passes in
> `src/tools/webfetch/native.ts`, which this issue used to point at, are closed.
> **Date opened:** 2026-11-10

## Context

Found by stress-testing `fetch` against Wikipedia and physics reference pages. The tool advertises
"STRUCTURED CONTENT as markdown … readable text, not raw bytes", so a model treats the output as
authoritative and cites it. The value-changing loss (`10<sup>12</sup>` → `1012`, the Planck constant
→ `x 10-34 J s`) and the noisy Parsoid leak are gone. What is left is the half of the original
complaint that was never about the conversion: **a caller has no way to know that math was
flattened**, because the fact the converter now states is discarded on the way to the result.

## Gap

The consumer needs **the disclosure on the result**, so a model that needs an exact value can
re-fetch rather than cite a corrupted one. Both ends exist and are not joined:

- The conversion pass reports it — `src/tools/webfetch/native.ts:47-53`
  (`ConvertedPage.mathFlattened`, set from both passes at `:413` and `:453`, handed up at `:503`) —
  and the sentence to say is already written and exported at `:63` (`MATH_FLATTENED_NOTE`).
- `fetch` already has a `note` field for exactly this kind of disclosure:
  `src/tools/webfetch/index.ts:732-734` emits one when a headingless `query` falls back to a
  proximity window, `:785-790` one for a clamped offset.
- The native branch, `src/tools/webfetch/index.ts:578-590`, copies `content`, `title`, `url`,
  `contentType` and `redirects` out of the provider's return and drops the flag on the floor.

## Why it is the way it is

Not a design rule — an unwired hand-off, created the same day the fix landed. The module header now
documents the loss and the report beside it (`src/tools/webfetch/native.ts:12-30`, the conversion
contract), so the conversion is no longer the undocumented part; `MATH_FLATTENED_NOTE` was exported
for `./index` to quote and nothing imports it. Every other lossy boundary in this tool family
reaches the caller: `grep` names what it skipped, `fetch` reports `offsetClamped` with a `note` when
an offset overshoots (`src/tools/webfetch/index.ts:640-641` computes the clamp, `:785-790` reports
it), and `download` reports `searchable` so a model does not grep a JPEG.

## Evidence

| Fact | Source |
|---|---|
| The conversion reports the flattening; the envelope ignores it | `src/tools/webfetch/native.ts:47-53` and `:503` vs `src/tools/webfetch/index.ts:586-590` (five fields copied, the sixth dropped) |
| The wording exists, exported, unused | `src/tools/webfetch/native.ts:63` (`MATH_FLATTENED_NOTE`); `grep -rn MATH_FLATTENED_NOTE src` reaches only `native.ts` and its test |
| The precedent shape to copy | `src/tools/webfetch/index.ts:732-734` (`"query"` → proximity `note`), `:785-790` (`offsetClamped` + `note`) |
| `format=html` is still the lossless remedy the note points at | `src/tools/webfetch/native.ts:484-488` returns the body verbatim, flagged `mathFlattened: false`; pinned by `src/tools/webfetch/webfetch.test.ts:1230` |

## Proposal

Three lines in `src/tools/webfetch/index.ts`; `native.ts` needs nothing.

1. Capture the flag where the provider result is unpacked: `const { fetchNative,
   MATH_FLATTENED_NOTE } = await loadNative();` at `:579`, `let mathFlattened = false;` beside
   `let redirects = 0;` at `:576`, and `mathFlattened = converted.mathFlattened;` with the other
   assignments at `:586-590`.
2. Emit it in both return paths — the `query` result and the window result — as
   `...(mathFlattened ? { note: MATH_FLATTENED_NOTE } : {})`, placed **before** the proximity spread
   (`:732-734`) and the clamp spread (`:785-790`) so that when a caller also clamped an offset or
   asked a headingless `query`, the note that explains the window it received is still the one
   returned. If both are wanted, appending is the alternative; overwriting is not.

**Alternatives considered.**

- *Say nothing and rely on the `^`/`_` markers now in the text.* Rejected: the markers rescue
  `<sup>`/`<sub>`, but `<math>` and MathML still flatten into juxtaposition — `\frac{\hbar}{2}` →
  `ℏ2`, `\tfrac12` → `12` — and a reader cannot see that a fraction was ever there.
- *Recover the LaTeX from `data-mw` `extsrc` instead of flattening MathML.* Still the better answer
  for math, still the larger change; kept out of scope below.

## Acceptance criteria

1. A `fetch` of a page containing `<sup>`, `<sub>`, or `<math>` returns a `note` naming the
   flattening and the `format=html` remedy, in `markdown` **and** in `text`; a page with neither
   returns no such note, and `format: "html"` never does.
2. When an offset clamp or a headingless-`query` proximity fallback applies at the same time, that
   note is still the one returned — the new disclosure never replaces the note that explains the
   window the caller got.

## Tests to add

- `src/harness.webfetch.test.ts`, or the `describe('fetch: math markup and attribute metadata
  (issue 0012)')` block already in `src/tools/webfetch/webfetch.test.ts` — the `<sup>`/`<math>`
  fixture through the **tool entry point**: `result.note` is `MATH_FLATTENED_NOTE` verbatim for
  `markdown` and for `text`, absent for a math-free page, absent for `format: "html"`; plus one case
  where an oversized `offset` clamps at the same time, pinning criterion 2. The conversion-level
  half of these already exists (`webfetch.test.ts:1246` and `:1273`); what is missing is the
  envelope-level assertion.

## Out of scope

- Full MathML/LaTeX semantic rendering, or recovering `extsrc` into the text (follow-up).
- Replacing the regex converter wholesale (may be its own issue once the disclosure lands).
- List nesting, which the header already declares a known limit.
- The marker conversion, the attribute-boundary leak, and the converter-side flag — **closed
  2026-11-11**; do not re-open them here.

## Update (2026-11-11) — partially closed

- **Fixed: `<sup>`/`<sub>` convert to explicit markers in BOTH passes.** `SUP_SUB`
  (`src/tools/webfetch/native.ts:276`) maps `<sup>12</sup>` → `^12` and `<sub>n</sub>` → `_n` —
  prefix-only, so a closing `_` cannot be mis-read as markdown's underscore emphasis. It runs from
  `flattenMathMarkup` (`:293-307`), called by the markdown pass at `:339` (after the `<pre>` and
  `<code>` extractions, so a code sample is never marker-ised) and by the text pass at `:434`.
  `10<sup>12</sup>` now yields `10^12`, and the NIST Planck constant yields `10^-34` — never `1012`
  or `10-34`.
- **Fixed: the attribute-boundary metadata leak.** `ATTR_RUN` (`:241`) consumes a `"…"` or `'…'`
  group verbatim, so a `>` inside a quoted attribute value no longer ends a tag; it backs the
  catch-all `TAG_STRIP` (`:246`) that both passes now use (`:400` and `:442`) — the two blanket
  strips this issue cited as `native.ts:263` and `:297`. `MW_METADATA` (`:259`) additionally drops
  `data-mw`/`data-mw-dt`/`data-parsoid` before conversion (after `extractPreBlocks`, so a code
  sample that mentions them is untouched), which makes every name-anchored pass that keeps a
  `[^>]*` boundary — `<li>`, `<a>`, `<p>`, `<div>` — safe on MediaWiki. `{{rp|`, `{{cite journal`,
  `"i":0` and the tell-tale `'>` are gone. Both mitigations this issue named are in place: the
  attribute-aware boundary (its primary proposal) **and** the targeted `data-mw` strip (its cheaper
  fallback), because the strip is what protects those named passes.
- **Fixed at the conversion level: the converter reports the loss.** `MATH_MARKUP` (`:283-284`)
  tests for `<sup>`, `<sub>`, `<math>` and the MathML element set **after** the metadata strip (a
  `data-mw` value can hold wikitext that spells `10<sup>12</sup>` literally, which is not flattened
  prose) and **after** `extractPreBlocks` (a highlighted snippet is not prose math either); the
  result is `ConvertedPage.mathFlattened` (`:47-53`), always false for `format=html` (`:487`) and
  for a non-HTML body (`:481`). The module header states the markers and the report
  (`:12-30`), which closes this issue's "math is not in the enumerated list of what the contract
  keeps" point. It is **not** delivered to the caller — that is the open part above.
- **Tests added**, all in `src/tools/webfetch/webfetch.test.ts` inside
  `describe('fetch: math markup and attribute metadata (issue 0012)')` (`:1166-1351`):
  `converts superscripts and subscripts into markers instead of joining them to the base` (`:1175`),
  `keeps the same markers in text output` (`:1192`), `does not read a NIST-style exponent as a
  subtraction` (`:1209`), `returns math and metadata markup verbatim when the caller asked for html`
  (`:1230`), `reports math as flattened exactly when math markup was flattened` (`:1246`),
  `names the flattening and the format=html remedy in the disclosure it hands ./index` (`:1273`),
  `does not report a code sample that mentions <sup> as flattened math` (`:1281`), `keeps Parsoid
  data-mw metadata out of mid-prose markdown` (`:1296`), ``treats a `>` inside any quoted attribute
  value as inside the tag`` (`:1335`). Each asserts an exact converted string (`toBe` on the whole
  content) or the exact fragments that must be absent — no range checks, no smoke assertions.
- **Offline evidence:** `yarn vitest run src/tools/webfetch/webfetch.test.ts` → 75/75 (66 before the
  change); with `native.ts` reverted to `HEAD:src/tools/webfetch/native.ts` the same run is
  **8 failed | 67 passed**, the failures being exactly the mechanism tests — so the guarantee is
  pinned, not assumed. `src/harness.webfetch.test.ts` 9/9; and `yarn vitest run
  src/core/tool-discovery.test.ts src/harness.webfetch.test.ts src/server/harnesses/{catalogue,
  presets,registry}.test.ts` → 111/111. `tsc --noEmit` clean (0 errors package-wide at the time of
  the run) and `eslint` clean on the changed source.
- **Criteria met:** 1 (`10^12` and `H_nO` in markdown and in text, never `1012`/`HnO`); 2 (NIST-style
  `x 10^-34 J s`, no `10-34`, in both formats); 4 (`{{rp|`, `{{cite journal`, `"i":0` and `'>`
  absent from a Quantum_mechanics-shaped fixture, in markdown and in text). Criterion 3 is met
  **one level short** — the flag is set and the wording exists, which is what `:1246` and `:1273`
  pin — but it is not on the result yet, which is the open gap.
- **Verification limits, stated rather than glossed:** criteria 1, 2 and 4 were verified against
  crafted HTML fixtures, not by re-fetching the live pages (this suite is offline), so the per-page
  trigger counts recorded in the deleted evidence rows (Photosynthesis 34, General_relativity 6,
  Quantum_mechanics 5, DNA 3) remain 2026-11-10 history and were not re-run; and a fixture is a
  miniature of the real markup, so a Wikipedia construct the fixture does not reproduce could still
  behave differently.
- **Drift in the cites above.** Every anchor this issue carried was re-read against the tree **before**
  the change and matched exactly: the markdown catch-all `/<[^>]*>/g` at `native.ts:263`, the text
  catch-all at `:297`, `PRE_WRAPPER_TAGS` at `:146`, the emphasis pass at `:210-214`,
  `convertHtmlToMarkdown` at `:191-277`, the text pass at `:283-309`, and `grep -nE 'sup|sub|math'`
  returning only the `PRE_WRAPPER_TAGS` line — zero drift on the pre-change file. The numbers used
  **after** the change are where those same points sit once the fix adds 157 lines to the file
  (349 → 506): catch-alls `:400` and `:442`, `PRE_WRAPPER_TAGS` `:176`, emphasis `:342-346`,
  `convertHtmlToMarkdown` `:313-414`, `convertHtmlToText` `:420-454`. The `index.ts` cites moved
  because a different change landed in that file the same day (+124/−5 against `HEAD`): the
  proximity `note` is now `:732-734` and the clamp `note` `:785-790` (this issue recorded
  `:623-625` and `:666-671`), and the clamp computation is `:640-641` (recorded `:564-566`). Test
  cites in `webfetch.test.ts` shift as the sibling 0014/0015/0016 fixes land in the same file; the
  ones above are as of this update.
- **Not covered by this change** (still out of scope): MathML semantics, `extsrc` recovery, a real
  parser, list nesting.

## Update (2026-11-11, fix) — closed

The one gap this issue reduced to — the converter's `mathFlattened` fact never becoming the
result's `note` — is closed. **Numbering note:** the disclosure was criterion 3 when the issue was
filed; after the reduction above it is criterion 1, and the precedence rule is criterion 2.

- **The hand-off shipped, in `src/tools/webfetch/index.ts` only — `native.ts` was not touched.**
  1. **Capture.** `let mathFlattenedNote: string | undefined;` at `:606`; the constant pulled from
     the same lazy import as the fetcher at `:612` (`const { fetchNative, MATH_FLATTENED_NOTE } =
     await loadNative();`); the flag read with the other provider fields at `:629`
     (`if (converted.mathFlattened) mathFlattenedNote = MATH_FLATTENED_NOTE;`).
  2. **Emit in both return paths, first so the existing notes still win** (a later spread clobbers
     an earlier one in an object literal): `:777` in the `query` result, immediately before the
     proximity spread at `:778-780`, and `:835` in the window result, immediately before the clamp
     spread at `:836-841`.
- **One deliberate deviation from the proposal's shape.** The proposal sketched a boolean plus an
  imported `MATH_FLATTENED_NOTE`. The constant lives in the **lazily imported** `./native` module,
  so it can only be destructured inside the native branch, while the note is needed by the return
  paths outside it; carrying a boolean would have meant a second module-scope import and broken the
  laziness rule in this file's header (S4). So the disclosure travels as one variable holding the
  note **text** — `undefined` doubles as "nothing flattened". Observably identical, and the wording
  stays owned by the module that knows the loss. The hosted providers never set it, so they never
  claim a flattening they did not do, and `format: "html"` / a non-HTML body report
  `mathFlattened: false` (`native.ts:481`/`:487`) so those paths stay silent by construction.
- **Criterion 1** (note present iff math was flattened, in the envelope):
  `src/tools/webfetch/webfetch.test.ts:1356-1375` — `discloses the flattening on the result in
  markdown and in text` asserts `result.note` is `MATH_FLATTENED_NOTE` **verbatim** in both formats,
  next to the exact converted content so the fixture cannot silently stop converting;
  `:1408-1427` — `discloses the flattening on a query answer as well as on a window` covers the
  second return path (`matchMode: "heading"`). Three silent paths, `:1377-1406` —
  `leaves the disclosure off the result when nothing was flattened`: prose that merely looks like a
  flattened exponent (`1012 kelvin`), `format: "html"` (the verbatim body the note points at), and a
  JSON body that is never converted. Each asserts the exact content **and** `note` absent.
- **Criterion 2** (the window note still wins): `:1429-1451` — `keeps the clamp note when a clamped
  offset lands on flattened math`, and `:1453-1474` — `keeps the proximity note when a headingless
  query lands on flattened math`. Both call the same page twice: once without the competing
  argument, asserting `note` IS `MATH_FLATTENED_NOTE`, so the precedence claim cannot pass on a
  fixture whose flag was simply never raised; then with the clamp/fallback, asserting the
  pre-existing note and `note` `not` the math note.
- **Fixture trap worth recording:** the `query`-mode fixture carries **three** headings. A page with
  two or fewer sections is answered by the proximity fallback
  (`src/tools/webfetch/sections.ts:52`, `FLAT_DOCUMENT_SECTIONS = 2`), which would have made that
  test pin the fallback rather than heading selection.
- **Verification.** `yarn vitest run src/tools/webfetch/webfetch.test.ts
  src/harness.webfetch.test.ts` → **111 passed** (106 before the change; 5 envelope tests added,
  none rewritten). Two mutation probes by editing `index.ts` and re-running: deleting both spreads
  fails **exactly** the four disclosure-bearing tests and nothing else — the fifth (the negative
  test) is the only one that cannot fail on a missing emission — and moving the math spread AFTER
  the clamp/proximity spreads fails **exactly** the two precedence tests, so the placement is
  pinned by the assertions rather than incidental. `npm run tools:manifest:check` → current, 31
  descriptors (neither the parameters nor `WebFetchResult` changed, so the contract did not move).
  `tsc --noEmit` → 0 errors package-wide at the time of the run; `eslint
  src/tools/webfetch/index.ts` clean (this repo's eslint config ignores `*.test.ts`).
- **Two sentences now stale in files this fix does not own** (one-line wording updates, left for
  the owner rather than edited here): `src/tools/webfetch/native.ts:23-25` and `:49-52` still say
  "./index does not read the flag yet", and `src/types/index.ts:2431-2433` still enumerates `note`
  as only the clamped offset and the proximity degradation.
- **The three stale sentences this fix named were corrected the same day** (2026-11-11):
  `src/tools/webfetch/native.ts` now states that ./index DOES read `mathFlattened` and put
  `MATH_FLATTENED_NOTE` on the result (header bullet and the `ConvertedPage.mathFlattened`
  field comment), and `src/types/index.ts`'s `WebFetchResult.note` comment enumerates all
  three note kinds — the clamped offset, the headingless `query` → proximity degradation, and
  the math flattening — together with the precedence rule (a window note wins over the math
  note because it explains the excerpt the caller is holding).
- **Verification limit, same as the reduction above:** every case runs against a crafted HTML
  fixture in an offline suite, not against the live pages, so a Wikipedia construct the fixture
  does not reproduce could still behave differently — but the disclosure is now keyed to the
  converter's own flag, which is format- and site-independent, so that risk no longer applies to
  this half of the issue.
- **Not covered** (unchanged): MathML semantics, `extsrc` recovery, a real parser, list nesting.
