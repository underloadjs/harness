# 0035 — The Rust port's README and knowledge state tool-catalogue numbers the generated table no longer matches

> **Status:** Fixed — 2026-11-14 (docs, then the in-crate citations the same day; the only
> residual left is that **nothing pins a citation** — the README row went stale again within a day,
> and by the third pass of 2026-11-14 the crate's untracked `docs/**` tree had been deleted outright,
> see the updates)
> **Severity:** Minor
> **Area:** `packages/typecrate/harness/README.md`, `packages/typecrate/harness/knowledge.md`, and
> (2026-11-14, second pass) the in-crate citations in `packages/typecrate/harness/src/tools/mod.rs`
> and `packages/typecrate/harness/tests/tools.rs` — so this entry is **not** docs-only
> **Date opened:** 2026-11-14

## Context

The port's Parity table is the only place that states how big the tool surface is on either side,
and a reviewer reconciling the two catalogues starts from its numbers. Read against the shipped
table, none of them could be reproduced: the row said "35 in the registry, of which `/tools`
lists **31**, because `tool-manifest.ts:1002, 1046, 1692, 1811` mark four `listed: false`", and
the columns beside it said 14 unimplemented names, 21 executable arms "of the 35 rows", and a
gateway pin at "31 LISTED rows". The generated table has **36** rows, lists **32**, names **15**
missing capabilities, and the four `tool-manifest.ts` lines cited do not hold the four names they
are cited for. Every one of those figures was true at some point — the catalogue is regenerated
from the TypeScript manifest, and `records` joined it and `fileList`/`task` were renamed since
those sentences were written — and nothing but the arrays themselves records the change, so the
prose fell behind one regeneration at a time.

## Gap

A reader who cannot re-check a count cannot use the doc. The port's overview must state, for each
side, the number of rows in the table, the number `/tools` advertises, the number withheld and by
what, the number of rows this build can execute, and the number it declares-but-does-not-run —
with citations that resolve to the declaration the number comes from.

## Why it is the way it is

The counts are pinned in code and prose, and only the code is checked. The Rust tests assert the
numbers themselves (`src/tools/mod.rs:897-898`: `summaries.len() == ENTRIES.len() -
UNLISTED_EXPECTED.len()` and `ENTRIES.len() == 36`; `tests/tools.rs:184, :189-195`: the listed set is
32), so a regeneration that moves a count fails a test and gets fixed in the arrays — and the
markdown keeps the old figure, because no test reads the markdown. The prose is also summarising a
**composed** surface on the TypeScript side: `/tools` is `[...createCoreToolEntries(),
...createToolCatalogue().entries]` (`src/server/api.ts:1050-1051`), whose 32 rows are not a subset
of the 32-row `tool-manifest.ts` — they include five rows that live in
`src/server/tools/shared/*.tool.ts` instead. Writing "the manifest's runtime rows" for that
composition is what made the sentence wrong the first time, and the two "35/31" figures were both
true of the pre-`records` table. The historical rows that carry those figures
(`knowledge.md:1537`, `:1552`, `:1614`) are dated entries and stay as written: the log records the
state at its date rather than rewriting it.

## Evidence

The numbers as shipped, verified 2026-11-14 from the sources the doc names. Rust paths are
relative to `packages/typecrate/harness`; TypeScript paths to `packages/underload/harness`.

| Claim (as shipped) | Stated | Actual | Authority |
|---|---|---|---|
| `README.md:145` (HEAD) — row and listing counts, both sides | 35 rows, `/tools` lists 31, `summaries()` → 31, `catalogue_summaries()` → 35 | **36 rows**, **32 listed**, `summaries()` → **32**, `catalogue_summaries()` → **36** | `src/tools/catalogue.rs:103` — `pub const ENTRIES: [Entry; 36]`, and 36 `name:` rows in the table; pinned at `src/tools/mod.rs:889-890` and `tests/tools.rs:184, :189-195` |
| `README.md:145` (HEAD) — the TypeScript side of the same row | 35 in the registry, 31 listed, because four rows are `listed: false` at `tool-manifest.ts:1002, 1046, 1692, 1811` | TS has **37** distinct tool names, and `/tools` answers **32**: `createCoreToolEntries()` → 15 and `createToolCatalogue().entries` → 17 (both factories run and counted). The cited lines are stale, and they name four of the FIVE withheld runtime rows | `src/core/tool-manifest.ts` (32 rows: 22 runtime + 10 preset; 15 `listed: true`, 17 `listed: false`), withheld runtime rows at `:1446`, `:2219`, `:2265`, `:2379`, `:2410` (`toolCancel`, `threadDelete`, `threadSend`, `threadRead`, `threadList`); the re-append is `src/server/harnesses/index.ts:189`, `:201` and the preset group rule `src/server/harnesses/core.ts:29-45` |
| `README.md:145` (HEAD), `knowledge.md:646` (HEAD) — which names are withheld on the Rust side | four, `toolCancel`, `threadSend`, `threadRead`, `threadList` | still four by name — but `threadDelete` is absent for a different reason: **it is not a row in this table at all** | `src/tools/catalogue.rs:563` — `const UNLISTED: [&str; 4]`; no `name: "threadDelete"` anywhere in the table, and no `"threadDelete" =>` arm in `src/tools/mod.rs:487-548` |
| `README.md:147` (HEAD) — catalogued-only names | "**14** names in `MISSING_CAPABILITY`", listing `profileManage`, `chapterManage`, `locationManage` | **15** names, and those three are the pre-rename spellings: the list carries `records`, `profiles`, `chapters`, `locations` | `src/tools/mod.rs:78` — `const MISSING_CAPABILITY: [(&str, &str); 15]`, names at `:79-124` |
| `README.md:146` (HEAD), `knowledge.md:655-660` (HEAD) — what executes | "21 executable arms = 19 catalogue tools + `task` + `actionRequest`", bodies at `mod.rs:486-527`, names `fileList` and `task`, "21 of the 35 rows run" | 21 arms **is** right, over 36 rows ("21 of the 36"); the bodies span `mod.rs:487-534`, and the two store-backed rows are `tasks` (`:537`) and `actionRequest` (`:548`) — `fileList` and `task` are the renamed spellings | `"name" =>` arms in `src/tools/mod.rs:487-560`: 21 distinct names (`read`, `write`, `edit`, `files`, `glob`, `grep`, `shell`, `gitDiff`, `syntax`, `timeNow`, `textCount`, `diceRoll`, `noteSearch`, `textSummarize`, `toolList`, `toolRequest`, `search`, `fetch`, `download`, `tasks`, `actionRequest`); the crate itself pins `fileList`/`task`/`profileManage`/`chapterManage`/`locationManage` as names that must NOT appear (`src/tools/mod.rs:910-921`) |
| `README.md:189` (HEAD) — the session toolbox | "the SESSION toolbox still shows all 35" | 36 | `src/tools/mod.rs:365` (`catalogue_summaries()` maps every `ENTRIES` row) |
| `README.md:294`, `knowledge.md:1676-1678` (HEAD) — the gateway pin | "pins the global `/v1/harness/tools` page at **31 LISTED rows** — the 35-row pin moved with the listing rule" | the pin is at **32 LISTED rows** over 36 generated | `packages/typecrate/services/tests/harness_gateway.rs:586-594` (the comment) and `:606-612` (`names.len() == 32`, `json!(32)`) |
| `knowledge.md:664` (HEAD) — the capability table's location | `MISSING_CAPABILITY` at `mod.rs:77` | `mod.rs:78` | `src/tools/mod.rs:78` |

## Proposal (what shipped)

Docs only — no `.rs` file changed, so no Rust check is owed by this entry:

- The Parity row now states the composition on the TypeScript side (37 names, 32 listed, 15 + 17
  from the two factories, `src/server/api.ts:1050-1051`) and the table on this side (36 rows, 32 listed,
  `catalogue.rs:103` + `catalogue.rs:563`), each with the citation that declares the number.
- `threadDelete`'s absence is stated as what it is — not a row, not withheld, not an arm, 404 on
  the identified read (`src/tools/mod.rs:373-382`) — instead of being hidden inside "four of five".
- The executable/catalogued-only split is 21 + 15 over 36, with the CURRENT names (`files`, `tasks`,
  `records`, `profiles`, `chapters`, `locations`) and a note that `fileList`/`task` are the pre-
  rename spellings the crate pins as absent.
- `knowledge.md`'s generated-table section carries the same composition plus the parity sentence
  (both surfaces answer 32 LISTED rows, and where each is pinned), and the gateway pin is stated as
  having **moved twice** (35 → 31 → 32) rather than once, so the dated history stays readable.
- Historical rows that state the old figures (`knowledge.md:1537`, `:1552`, `:1614`) are untouched:
  they are dated entries about the state at their date.

**Alternatives considered and rejected.**

- *Generate the numbers into the markdown from the arrays.* Rejected as over-engineering for two
  prose files: the arrays are already pinned by three Rust tests, and the failure mode here was a
  hand-written sentence about the OTHER side's composition, which a Rust-side generator would not
  have caught either.
- *Update the stale `tool-manifest.ts:1002, 1046, 1692, 1811` citations inside the Rust comments
  too* (`src/tools/mod.rs:886`, `tests/tools.rs:190-191`, `knowledge.md:1537`). Rejected for this
  pass: they are `.rs` edits, which put a `cargo` re-run on the critical path for comment-only
  value, and the table row in `knowledge.md` is a dated record. Recorded below as the residual.
- *State the counts without the citations.* Rejected: the previous sentence had counts and no
  resolvable citation, which is how it survived being wrong.

## Acceptance criteria

1. Every count in the Parity table matches the declaration it names, and each number cites that
   declaration: 36 rows (`catalogue.rs:103`), 32 listed (`catalogue.rs:563` + `tests/tools.rs:184, :189-195`),
   21 arms (`mod.rs:492-566`), 15 catalogued-only (`mod.rs:78`), toolbox 36 (`mod.rs:365`).
   **The counts hold; the citations do not** — the table is regenerated, so the cited lines move
   under the doc. Same-day regression, with the authoritative map, in the update.
2. The TypeScript column is reproducible from the TypeScript package: running the two factories
   answers 15 and 17, and the composed page is 32 rows with the five withheld names absent.
3. No sentence in either file describes the CURRENT table as 35 rows / 31 listed / 14 withheld /
   14 unimplemented, and no current-name sentence uses `fileList`, `task`, `profileManage`,
   `chapterManage` or `locationManage` as if they were live names.
4. The gateway pin is quoted as it is today (32 LISTED over 36), with the earlier figures kept only
   inside dated statements about the pin moving.
5. Anything the docs assert that this pass could not execute is labelled as such — the
   "**96 passed, 0 failed**" figure in `README.md:290-296` and `knowledge.md:1673-1680` is a restated
   result of the last `typecrate/services` test run, not a result of this pass (no `cargo` run was
   performed here, because no `.rs` file was touched).

## Tests to add

No test can close this entry by itself, because the defect is prose about another package's
composition — the arrays themselves are already pinned (`src/tools/mod.rs:897-898`, `:989`;
`tests/tools.rs:184, :189-195`; `packages/typecrate/services/tests/harness_gateway.rs:606-612`). The
durable guard is on the TypeScript side, and it exists:

- `packages/underload/harness` regenerates `src/core/tool-manifest.ts` and fails on drift
  (`yarn tools:manifest:check`, run first by both `yarn test` and `yarn typecheck`), so the
  citations added here are checked against a table that cannot silently change.

Worth adding if the port grows a doc-check step:

- A Rust test asserting the two markdown files contain no row/listing count other than the pinned
  numbers (a doc-lint alongside `the_catalogue_is_the_documented_shape_in_the_documented_order`),
  and one asserting `MISSING_CAPABILITY`'s names are exactly the 15 the docs list.
- On the TypeScript side, a case that composes `[...createCoreToolEntries(),
  ...createToolCatalogue().entries]` and asserts the 32 names and the five absent names, so the
  figure the port quotes has a pin in its own package.

## Out of scope

- The order claim. There is no automated order-parity test between the two catalogues, and the two
  tables are not the same sequence: `toolCancel`/`threadSend`/`threadRead`/`threadList` sit at
  positions 16-19 here (`catalogue.rs:103` onward) and at the END of the TypeScript runtime manifest
  (`tool-manifest.ts:1410`, `:2182`, `:2223`, `:2269`, `:2379` — after `fetch`). The docs now state
  the sets and counts rather than asserting an order the code does not pin. Proving or correcting
  the order is a port task with its own test, not a doc edit.
- The `96 passed, 0 failed` figure, restated above as unverified by this pass — it belongs to
  `packages/typecrate/services`, and re-running that suite is outside this entry.
- Anything the port genuinely lacks rather than mis-describes: the 15 `MISSING_CAPABILITY` rows are
  declared-not-executed by design, and `threadDelete` having no row is a catalogue question for the
  port owner, not a wording one.

## Update (2026-11-14, second pass) — the residual closed, and this entry's own numbers corrected

Verification method, so the next reader can re-run it: `yarn vite-node Temp/t19-docs/probe-catalogue.ts`
(git-ignored scratch; it imports `createCoreToolEntries` from `src/server/harnesses` and
`createToolCatalogue` from `src/core/tool-manifest`, prints the generated Rust `ENTRIES` rows by
`Listing`, and set-diffs both sides). Line numbers below are current-at-this-pass, not as of the
Evidence table above.

1. **The `.rs` residual is closed — the stale in-crate citations were refreshed the same day.**
   `src/tools/mod.rs:353`, `:367`, `:893-894`, `:995` and `tests/tools.rs:193`, `:203` now point at
   `catalogue.rs:103` (`pub const ENTRIES: [Entry; 36]`) and `catalogue.rs:563`
   (`const UNLISTED: [&str; 4]`), and `tests/tools.rs:191-194` quotes the five TypeScript
   `listed: false` sites as `tool-manifest.ts:1446, 2219, 2265, 2379, 2410` — all five re-checked
   line-by-line and **all five resolve** to a `listed: false` owned by the named row (`toolCancel`,
   `threadDelete`, `threadSend`, `threadRead`, `threadList`). That closes the first
   "Alternatives considered" rejection and the first Out-of-scope bullet, which are left as written
   because they record the reasoning at their date. The package is therefore **not** untouched: an
   `.rs` file changed, so `cargo test` is owed by the crate owner, and no `cargo` run was performed
   by this pass.
2. **The failure mode recurred within the same day, which is the entry's thesis.** The Parity row
   still says `catalogue.rs:88` / `catalogue.rs:542` (`README.md:145`) and `knowledge.md:657` says
   `catalogue.rs:542`, while the declarations now sit at `:103` and `:563` — the regenerated
   descriptions pushed both arrays down 15 and 21 lines. Same row, same file, four days of drift in
   one afternoon. This is why AC1 is annotated rather than ticked: the **counts** are still right,
   the **citations** are the fragile half, and a number-generator would not have caught it either
   (the first rejected alternative stands, but for a narrower reason than the entry states).
3. **Correcting this entry's second finding: 13 description mismatches, not 22.** The probe
   reconciles 36 generated Rust rows against 37 TypeScript names (32 manifest rows + 5 standalone
   `src/server/tools/shared/*.tool.ts` metadata literals), 0 unmatched either way. **23 descriptions
   are byte-identical; 13 differ**: `toolRequest`, `toolCreate`, `records`, `tasks`, `profiles`,
   `chapters`, `locations`, `read`, `write`, `edit`, `files`, `glob`, `grep`. If the crate docs quote
   a "22" anywhere, quote 13 instead.
4. **The arm/line citations in the Evidence table and README drift the same way** (recorded here so
   nobody re-verifies from scratch): the 21 executable arms are unchanged as a *set* but now span
   `mod.rs:492-566` (`"read"` at `:492`, `"download"` at `:537`, `"tasks"` at `:542`,
   `"actionRequest"` at `:553`, `other =>` at `:567`); the `MISSING_CAPABILITY` refusal text is
   `mod.rs:471-472`; the pins that `fileList`/`task`/`profileManage`/`chapterManage`/`locationManage`
   must stay absent are `mod.rs:920-924`; `result.rs:738` (`failed_outcome`) and `mod.rs:78`
   (`MISSING_CAPABILITY`, 15 names) still resolve.
5. **Verification boundary.** This pass verified the counts and citations by reading the two
   generated arrays and running the two TypeScript factories, plus
   `packages/typecrate/services/tests/harness_gateway.rs:606-612` (32 LISTED names, `json!(32)`) and
   `tests/tools.rs:184` (`the_catalogue_lists_every_group_in_the_published_order`) — which pins rows
   `= 32`, the first row, group order, visibility and tags, and **no cross-catalogue order parity**,
   exactly as the Out-of-scope bullet claims. Not verified here: any `cargo` execution, the
   `96 passed, 0 failed` restatement, and `mod.rs:365` / `mod.rs:373-382`, which were not re-opened.

## Update (2026-11-14, third pass) — the crate moved under this pass; every crate-side number re-measured

Method, so the next reader can re-run it: `yarn vite-node Temp/review-probe/drift.ts` from the repo
root at 08:30 (output kept at `Temp/t21-docs/drift-0830.out`), `yarn vite-node` plus direct greps
against the crate files, and `yarn tools:manifest:check` from `packages/underload/harness`. **Read
only**: nothing in `packages/typecrate/**` was touched by this pass, and no `cargo` command was run.

- **Concurrency caveat, stated first because it invalidates re-reading, not just re-verifying.** The
  crate is a **separate git repo** (`git rev-parse --show-toplevel` → `packages/typecrate/harness`,
  HEAD `d507659`, dated 2026-11-13) and another agent was editing it throughout this window. Its docs
  surface changed **during** this pass: at ~07:50 it had `README.md` (1,820 lines), `knowledge.md`
  (1,032), `docs/README.md` (145), `docs/tool-support.md` (40) and `docs/issues/` (23 files); at 08:40
  it has `README.md` **306 lines**, `knowledge.md` **1,978 lines**, and **no `docs/` directory at all**.
  `git ls-files docs` returns nothing and `git ls-tree HEAD` has no `docs` entry, so the whole tree was
  untracked and left no diff. Every `docs/**` citation in this entry — the Gap's `docs/README.md:9`,
  the Evidence row for `docs/tool-support.md:13`, and the "23 files" claim at `docs/issues/README.md:3`
  — is therefore **unresolvable on the current tree**: `unconfirmed`, with this pointer rather than a
  deletion, because the claims were true when measured and the files were never under version control
  to begin with.
- **The counts are still right, and that is the point the entry makes.** Re-measured 08:30-08:40: the
  TypeScript manifest is current at **32 rows** (`yarn tools:manifest:check`), plus the five
  `src/server/tools/shared/*.tool.ts` metadata literals (`diceRoll`, `noteSearch`, `textCount`,
  `textSummarize`, `timeNow`) = 37 names, 32 listed. The crate declares `pub const ENTRIES: [Entry;
  36]` at `src/tools/catalogue.rs:103` and 36 rows parse out of it, 32 with `listed: true`;
  `const UNLISTED: [&str; 4]` at `:563` withholds `toolCancel`, `threadSend`, `threadRead`,
  `threadList`. Name sets reconcile at 36 matched, **0 crate-only**, and one TypeScript-only name,
  `threadDelete`.
- **Corrections to this entry's own description drift numbers.** Byte comparisons still give **23
  identical, 13 differing**, and the 13 are the same set the second pass listed (`chapters`, `edit`,
  `files`, `glob`, `grep`, `locations`, `profiles`, `read`, `records`, `tasks`, `toolCreate`,
  `toolRequest`, `write`) — so "13, not 22" survives. What the second pass did not measure is the rest
  of the row: at the same moment **9 more rows differ in `parameters_json`**, which is why the probe
  reports 22 mismatching *field* pairs. The two numbers are not in conflict — 13 is the description
  count, 22 is descriptions plus parameter documents — and a future reader who sees "22" quoted in a
  probe log should read it as the field-level total. Per-argument drift rides along
  (`argProblemCount` 1-13 on `records`, `tasks`, `files`, `grep`, `glob`, `edit`).
- **Order parity, now measured rather than asserted.** 15 of the 32 listed names sit at a different
  index in each table: the crate carries the four withheld thread rows at positions 17-19 and the
  preset rows at 20-31, while TypeScript keeps them at 30-32 and 17-28 (`gitDiff` rust 29 / ts 25,
  `download` 29/26, `search` 35/27, `fetch` 36/28 are the tail). The Out-of-scope bullet that says no
  cross-catalogue order parity is pinned holds exactly:
  `tests/tools.rs:184` (`the_catalogue_lists_every_group_in_the_published_order`) pins `rows.len() ==
  32` (`:191`), `names.len() == 32` (`:197`) and the first row (`:198-199`) — all crate-side.
- **AC1's annotation is re-confirmed, with a longer list of dead pointers than the second pass had.**
  The Parity row still cites `src/tools/catalogue.rs:88` for `ENTRIES` and `:542` for `UNLISTED`
  (`README.md:145`) while the declarations sit at `:103` and `:563`; `knowledge.md:657` still cites
  `catalogue.rs:542`. Same row, third sighting in one day. New this pass, same row:
  `README.md:146`'s arm citations are all ~5-10 lines low — it cites `mod.rs:487-534` for the 19 rows
  with bodies and `:537`/`:548` for `tasks`/`actionRequest`, and the arms are actually at `:492`
  (`"read"`), `:537` (`"download"`), `:542` (`"tasks"`), `:553`(`"actionRequest"`) with `other =>` at
  `:567`; the absent-name pins it puts at `mod.rs:910-921` are at `:920-924`; and
  `README.md:145`'s `src/tools/mod.rs:365` for `catalogue_summaries()` now lands between `summaries()`
  (`:359`) and `catalogue_summaries()` (`:370`). Two of its TypeScript citations also moved —
  `harnesses/index.ts:189`/`:201` are the `entries.push(websearch.entry)`/`entries.push(webfetch.entry)`
  lines, now `:197`/`:213` — while `api.ts:1050-1051` still resolves (it now reads
  `const coreEntries = createCoreToolEntries();` then `[...coreEntries, ...catalogue.entries]`, the same
  composition through two locals) and all five `tool-manifest.ts:1446, 2219, 2265, 2379, 2410`
  `listed: false` citations still resolve, owner by owner.
- **The second pass's crate-side item 1 is re-verified by a different means, so it stays closed.** The
  in-crate citations it refreshed no longer carry Rust line numbers at all: `src/tools/mod.rs:890-896`,
  `:992-996` and `tests/tools.rs:193`, `:203` now name the TS manifest lines and the **symbol**
  `catalogue::UNLISTED` (and `src/tools/mod.rs:998` restates the four names as `UNLISTED_EXPECTED`), so
  a regeneration can no longer invalidate them by moving a declaration. That is strictly better than
  what the second pass recorded ("now point at `catalogue.rs:103` and `catalogue.rs:563`"), and it is
  the only reason the entry's thesis is not fully vindicated: the crate fixed its own half by dropping
  numeric pointers, and the README's half is unfixed.
- **Refused: "the `.rs` files were changed and committed today upstream."** The crate has **no commit
  dated 2026-11-14** (`git log --since 2026-11-14 -- '*.rs'` is empty; newest is `d507659`, 2026-11-13).
  The correct basis is the **dirty worktree**: `git status --porcelain -- '*.rs'` lists 6 modified files
  — `src/agents/profiles.rs`, `src/ports.rs`, `src/tools/catalogue.rs`, `src/tools/mod.rs`,
  `tests/http_host.rs`, `tests/tools.rs`. The conclusion the second pass drew is unchanged — a `cargo`
  run is owed, and this pass ran none — but it rests on uncommitted edits, not on a commit.
- **Unconfirmed: the generator, and so the whole regeneration route.** `src/tools/catalogue.rs:4` still
  announces `GENERATED FILE (Temp/typecrate-harness/t4/generate-catalogue.mjs)`, but
  `Temp/typecrate-harness/` holds `context-lane`, `data-plane`, `gateway`, `http-host`, `http-sessions`
  and no `t4/`; nothing named `generate-catalogue*` exists anywhere in the repo; and the crate's
  `package.json` scripts are cargo-only (`check`/`test`/`lint`/`fmt`/`build`/`start`/`verify`). So the
  "regenerate the table" remedy this entry's Context implies cannot be executed from any checked-in
  artifact today. Flagged, not fixed: the crate's owner holds that file.
- **What remains owed, with the method for each.** (1) A `cargo test` run over the 6 dirty `.rs` files —
  everything above about `tests/tools.rs` and `mod.rs` was read, not executed. (2) The
  `96 passed, 0 failed` restatement in the Evidence table, still never re-measured. (3) AC1's real
  demand, **nothing pins a citation**: `README.md:145`, `README.md:146` and `knowledge.md:657` are
  wrong in 8 places right now, this entry's own Evidence and Update tables quote addresses that were
  live only for the hours they were written, and no check in either package compares a doc citation to
  the file it names. (4) The untracked-docs problem this pass surfaced: `packages/typecrate/harness/docs`
  was never in git, so a docs issue log can be deleted with no trace — the "kept for review, delete it
  when the owner's run confirms" convention this repo uses has no anchor there.

## Update (2026-11-14, fourth pass) — the drift recurred the same day, the owed `cargo` run was performed, and 21 more citations were re-anchored

Read from crate HEAD `d507659` (dirty) with the harness at `cef43af` (dirty). Every number below was
re-derived by probe today — `Temp/t25-docs/cite-audit4.ts` (parses every `file:NNN` citation in
`README.md` + `knowledge.md`, resolves the file, prints what the cited line actually holds and whether
the doc's own subject token appears near it), `cite-fix.ts`, `cite-locate{,2,3,4}.ts`, `doc-lines.ts`
and `guide-check.ts`, all under `yarn vite-node` — and, unlike the three earlier passes, **the crate's
test suite was executed** (item 5).

- **The failure mode repeated inside the same day, which is the strongest form of AC1's argument.** The
  third pass re-derived the tool-catalogue rows against the tree at its own hour; by this pass that tree
  had moved again: `src/tools/catalogue.rs` 577 → 589 lines, `src/tools/mod.rs` 1182 → 1187,
  `src/agents/profiles.rs` 242 → 222 (the multi-line `r#"` guideline blocks collapsed back to five
  one-line constants), and `src/ports.rs`, `tests/tools.rs` and `tests/http_host.rs` were re-edited (the
  modified-path set is still the same 8 paths, but every diff in it changed size).
- **What survived that churn** (re-verified, all still correct): `pub const ENTRIES: [Entry; 36]` at
  `catalogue.rs:103`, `const UNLISTED: [&str; 4]` at `:563`, `const MISSING_CAPABILITY: [(&str, &str); 15]`
  at `mod.rs:78`, the 19 bodies at `:492-537` with `tasks` at `:542`, `actionRequest` at `:553` and
  `other =>` at `:567`, the capability door at `:466-475`, the stale-name loop at `:919-931`,
  `completed_outcome` / `failed_outcome` at `result.rs:704` / `:738`, and the 32-row pin at
  `tests/tools.rs:189-195`. The TS side re-checked too: `api.ts:1050-1051` still composes 15 + 17 = 32
  rows, and the five `listed: false` rows are still at `tool-manifest.ts:1446, 2219, 2265, 2379, 2410`.
- **What did not survive is the mechanism, not the count.** This entry's third pass described the
  capability door as keyed on `availability_of(&Options, name)`; that free function is gone.
  `availability_of` is now a method (`mod.rs:199`, `(&self, entry: &Entry) -> Option<ToolAvailability>`)
  reporting `Available` / `Unconfigured` per group, `Options` is unchanged at `:127-133` (`web_keys`,
  `fetch_enabled` — still the only inputs), and the door the README describes is the `MISSING_CAPABILITY`
  lookup at `:466-475`, whose sentence (`:472`) is the one the README quotes. `is_declared()` still
  exists, as a method (`:293`), and the registry filter at `:294` is what keeps every catalogued-only
  name out of the declaration list.
- **The owed `cargo` run — done.** `cargo test -p typecrate-harness --offline` from
  `packages/typecrate/harness`, with `TMPDIR` and `CARGO_TARGET_DIR` pointed at repo-root
  `Temp/t25-docs/`: **exit 0, 480 passed, 0 failed** across 21 test targets plus the doctest target.
  Per target: lib 172, `bin/server` 8, context_lane 11, contract_message_flags 9, data_plane 17,
  foundation 24, http_host 17, http_sessions 19, plugin_host 31, plugins 15, projector 15, routes 6,
  runtime_execution 12, store 27, store_restore 4, stream 21, tools 24, transport 24, turn 13, wave_one
  10, worker_execution_http 1, doctests 0. Every `.rs` mtime predates the run, so the six dirty source
  files were green exactly as they stand — which is the first time this entry's claims about
  `tests/tools.rs` and `mod.rs` have been executed rather than read.
- **Twenty-one drifted citations fixed in the two crate docs** (the claim / stale cite / what that line
  holds today / the re-derived cite):

  | Crate doc claim | Cited | That line holds today | Re-derived |
  |---|---|---|---|
  | `ProjectorFactory::create` takes no prompt (`README.md` Deviations 3) | `ports.rs:239-241` | the `settle` doc comment | `ports.rs:320-321` |
  | the unlisted row 404s, matching TS (`README.md` Deviations 8) | `api.ts:1847` | a `blockThoughtOf` line (and past EOF in `src/frontend/api.ts`, which the bare name also resolves to) | `api.ts:2481-2493` (`getToolOne`) + `api-reads.ts:977-978` (`toolEntryOf`) |
  | the harness instruction `chars` is UTF-16 (`knowledge.md`, T-stage) | `api/harnesses.rs:399` | inside the "not a member of harness" 404 | `api/harnesses.rs:410-413` (`encode_utf16().count()`) |
  | attachments fall through to the lane backlog | `store/turns.rs:143-159` | the unknown-thread guard (`:143` blank) | `store/turns.rs:155-179` (build at `:201`, persist at `:233`) |
  | the projector handles `HarnessEvent::ActionRequest` | `projector.rs:1256` | `sync_tails`' body | `projector.rs:1788-1790` |
  | queue `position` 0-based vs the receipt's 1-based ordinal | `read.rs:1160-1162` | `connected_thread_ids` in `src/read.rs`, which is 367 lines — the cite is past EOF for the file the bare name matches first | `store/read.rs:1335-1337` (mapping at `:1345-1352`) |
  | the runtime pushes its host view at creation | `runtime.rs:464` | blank, inside `cached_runtimes` | `runtime.rs:583` (`set_host_view` in `build_runtime`) |
  | …and after every save / `save_agents` / rollback | `runtime.rs:542, 589, 674, 700, 715` | five unrelated lines | `:661`, `:708`, `:793`, `:819`, `:834`, all through `sync_store` at `:718-747` |
  | `action_closed_reason` | `store/actions.rs:784-801` | its own doc comment (`:784` blank) | `store/actions.rs:792-802` |
  | `Store::publish_actions_closed` | `store/actions.rs:803-829` | `impl Store` (`:803` blank) | `store/actions.rs:812-830` |
  | steering a failed, unconsumed run re-queues | `store/turns.rs:1239-1264` | mid-function, blank at the end | `store/turns.rs:1263-1289` |
  | `sync_store()` clones each value out of its own lock | `runtime.rs:599` | blank | `runtime.rs:718-747` |
  | `TurnBlockDetail` flattens a `ContextBlock` | `contract.rs:3097` | the `ContextBlockKind` doc comment | `contract.rs:3104-3106` |
  | deltas fold through `fold_prose`, plus the answer-segment note | `projector.rs:1301-1305`, `:1568-1573` | the unredact `node:set`, and the `attempt_commit` arm | `projector.rs:1399-1403`, `:1676-1680` |
  | the journal writes `{version, sequence, timestamp, event}` | `journal.rs:104-112`, `journal::journal_event` | blank; no such function exists | `journal_event_line`, `journal.rs:144-153` — and the claim is REVERSED (below) |
  | TS raises the first bad config value | `config.ts:221`, `:241` | blank (both) | `config.ts:226`, `:232`, `:246` |
  | the execution-mode default is `inline` | `config.ts:119` | blank | `config.ts:118` (`:124` for the io knob) |
  | selectability has two gates (`requireAgent`) | `registry.ts:329-353` | inside `normalizeSubagents` | `registry.ts:371-395` (400 at `:378-384`, 409 at `:386-392`) |
  | the tool detail halves come from `toolDetailOf` | `api-reads.ts:1158-1162` | blank | `api-reads.ts:1493-1505` |
  | `pending_action_count` is the entry count | `api-reads.ts:227` | blank | `api-reads.ts:257` |
  | the `agentColors` TS authority | `registry.ts:430,569,589`, `persistence.ts:131`, `harness-api.ts:454,694` | blank / two unrelated helpers / a file with no `agentColors` clause at all | `registry.ts:588-642`, `:670`, `:771-773`, `:816-818`, `:952` + `shared/harness-api.ts:142` (reader at `:510-527`) |
- **Three prose claims the tree contradicts, recorded rather than rewritten** (they sit in dated stage
  records, so the convention is supersede-and-report): (1) `knowledge.md`'s journal item said a
  TypeScript-written journal reads back as ZERO records because the writer emits the legacy envelope —
  today `journal_event_line` (`journal.rs:144-153`) emits TS bytes (`type`, `v`, `turnId`, `index`, `at`,
  `event`) and the module doc (`:74-80`) states the legacy envelope is the one NOT accepted on read,
  with the per-file `sequence` counter gone (`:45-46`); this one was inside an open-items list rather
  than a dated record, so it WAS rewritten. (2) The stage record that the working tree's
  `src/bin/server.rs` "currently fails to BUILD" with a `match`-arm error at `:633-639` is superseded by
  this pass's clean compile (the file is 616 lines; that cite is past EOF, and the SIGTERM arm is
  `:378-397`). (3) The note that `registry/mod.rs:803-823` (`instruction_summary_of`) and
  `store/agents.rs:126` "still use `chars().count()`" is false today: both call `display_chars`
  (`:820`, `:823`, and `store/agents.rs:126`), which the later stage record in the same file already
  says. And `README.md`'s "record-only half" deviation was rewritten inline, because the README is the
  live surface — with the explicit caveat that its id rule was NOT re-derived by this pass.
- **The audit's remaining surface, stated as a count so nobody reads this as "done":** of **298**
  machine-parsed citations in the two crate docs, 25 now carry the doc's own subject token at the cited
  lines, 1 is past EOF (the dated `bin/server.rs` record above), 26 land on a blank line, 48 have the
  subject token absent within ±25 lines, and 188 are ranges or prose references no machine check can
  adjudicate. The blank and absent-token rows are the ones a human should re-anchor next; several of
  them are ambiguous because the docs cite a bare file name (`api.ts` matches both
  `packages/underload/harness/src/server/api.ts` and `src/frontend/api.ts`, and `read.rs` matches both
  `src/read.rs` and `src/store/read.rs`) — which is the same reason AC1 asks for symbols.
- **Still owed.** (1) The `96 passed, 0 failed` services restatement in the Evidence table — NOT
  re-measured by this pass either, because `packages/typecrate/services` is outside both writable
  packages; the comment it leans on does resolve and says 32 LISTED over 36 rows
  (`services/tests/harness_gateway.rs:586-594`, pin at `:608`). (2) AC1's real demand, **nothing pins a
  citation** — unchanged, and now with a fourth data point: 21 drifted cites found and fixed in one
  audit, one day after this entry's own "fixed" pass, with no check in either package comparing a doc
  citation to the file it names. A `yarn vite-node` probe over `README.md` / `knowledge.md` /
  `docs/issues/**` is the whole implementation. (3) `packages/typecrate/harness/docs/` is still
  untracked, and `catalogue.rs:4` still announces a generator
  (`Temp/typecrate-harness/t4/generate-catalogue.mjs`) that exists nowhere in the repo.
- **Cross-reference:** the guideline cross-reference drift in the same crate (three of the five
  `profiles.rs` doc comments point three lines short of the TS declarations, and the `DISCOVERY_GUIDELINE`
  / `TOOL_CREATE_GUIDELINE` strings have diverged from the TS text) is recorded in 0028's fourth pass,
  because it is that issue's parity surface rather than this one's table.
