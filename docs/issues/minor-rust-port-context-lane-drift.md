# 0017 — The display lane (context bar rows) landed in TypeScript and is not in the Rust port

> **Status:** Open
> **Severity:** Minor (drift risk — the Rust port is a faithful-port target, so an unported
> contract field is a divergence a later stage has to re-derive by hand)
> **Area:** `packages/typecrate/harness` (port target); `src/shared/turn-display.ts`,
> `src/server/protocol.ts`, `src/server/sessions.ts`, `src/server/turn-projector.ts`,
> `src/core/snapshot.ts`, `src/harness.ts`, `src/plugins/context-compaction.plugin.ts`
> **Date opened:** 2026-11-10
> **Reduced 2026-11-11 (second pass):** the published contract field, the fold's two-source rule,
> the durable shapes and every test this issue asked for have landed, so this file now carries only
> the one capability the port still lacks — raising a lane (proposal step 5, blocked on the plugin
> host). Status stays **Open** for that reason; nothing else in the file is live.

## Context

The context bar of a turn now paints **one stacked row per display lane**. A summarize
compaction raises its conversation's lane by one at the moment the compaction instruction is
committed, so the turn the boundary happened in shows two rows: the pre-compaction segments on
row N and the compaction answer on row N+1. The feature is the server half of a two-worker
wave — the TypeScript server side is complete and test-covered; the browser wave renders the
rows from `ContextBlock.lane` and owns no lane arithmetic either.

The Rust port (`packages/typecrate/harness`) mirrors both halves this feature touches: the
contract (`src/contract.rs`, generated-equivalent of `src/shared/harness-api.ts` and
`harness.swagger.yaml`) and the display fold (`src/projector.rs`, the port of
`src/server/turn-projector.ts`). Neither has the field yet.

## Gap

What a reader of the Rust crate cannot today do:

- **raise a lane.** Every other half of the feature is ported (the second-pass update below
  records what landed and where), but a summarize compaction still cannot bump its conversation's
  lane in the port, because no plugin hook executes there. A Rust session can only ever paint the
  one row its durable `core.threads[].contextLane` already carries; it can never move to the next
  one.

## Why it is the way it is

The port is staged (`packages/typecrate/harness/knowledge.md:7-66`, "Stage map"). This field
postdates every stage that has shipped: T1-T7b, T9 and T10 are done, and the still-unported work
is the module host, the worker backends and the plugin host (`:61-66`). When this was filed the
crate had no lane anywhere. Nothing in the port decides independently what a lane means: the
TypeScript side is the source of truth, and the swagger spec is the source of truth for the
contract. So the drift was expected and bounded — a pending resync, not a design disagreement —
and it is recorded here so the resync is not re-derived from scratch. The resync has since
started: the store, the journal and the fold already carry the lane, and only the published
contract field is missing. The 2026-11-11 update records exactly how far it got.

Two halves of the feature are deliberately NOT contract-visible and therefore are not swagger
drift at all: `SessionTurn.lane` and `HarnessThreadRecord.contextLane` are internal-only, and
`SessionTurnEvent.lane` rides an event object the spec keeps open (`HarnessEvent` sets no
`additionalProperties: false`). Only `ContextBlock.lane` is published.

That last sentence is the easy one to read too narrowly, so it is worth stating what the port
has to do about it: the per-event `lane` key is a SECOND copy of the same number, written onto
the open `HarnessEvent` objects the recorder stores (`src/server/sessions.ts:7936`, `:6985`),
and it is spec-valid precisely because `HarnessEvent` is open — which is also why the generated
TypeScript interface has no `lane` member at all (`src/types/index.ts:2720-2885` declares the union
without it, and the fold therefore reads it through a cast,
`src/server/turn-projector.ts:1435-1439`). A port that mirrors only the published
`ContextBlock.lane` still cannot replay the bar: the event stamp is the fold's INPUT, so the
port's recorded-event type must carry an optional `lane` on every event it folds and pass it
through the journal and the document verbatim, exactly as TypeScript does — the absence of a
generated field is not permission to drop the key.

## Evidence

| Fact | Where |
|---|---|
| Published field: `ContextBlock.lane`, integer, `minimum: 0`, absent ⇒ lane 0, mint-assigned and immutable (not a patch key) | `src/server/harness.swagger.yaml:8122`, generated into `src/shared/harness-api.ts:3320` (inside `ContextBlock`, `:3299`) and `src/shared/turn-display.ts:491` |
| The TypeScript fold's rule: an event-driven segment takes the event's lane, a non-event segment (`system` / `prompt` / `steer`) takes the turn's starting lane, `0` is never written, and a `context:set` patch never carries a lane | `src/server/turn-projector.ts:1409-1449` (`laneOfEvent` / `laneOfTurn` / `laneFieldsOf`), mints at `:1564`, `:1588`, `:1662`, `:2163`, `:2219`, `:2313`, `:2490`, `:2603` |
| The stamp is written by the recorder at record time, read live per event | `src/server/sessions.ts:2745` (`contextLaneOf`, its rule comment `:2718-2744`), `:7924-7936` (model-run recorder: the rule at `:7924-7933`, the live read at `:7934`, the write at `:7936`), `:6978-6985` (command recorder, one rule for both) |
| Durable per-conversation lane, with its strict snapshot whitelist and normalization (`0` never persisted) | `src/types/index.ts:2608` `HarnessThreadRecord` with `contextLane` at `:2647`, `:3067` `HarnessThreadSnapshot` with `contextLane` at `:3080`, `src/core/snapshot.ts` `readThreads` (`contextLane` in the key list + non-negative-integer read at `:758-763`, labelled `snapshot.threads` at `:950`, refusal sentences in `src/core/snapshot-validation.ts:90`/`:98`), `src/harness.ts:5781` (`setThreadContextLane`) |
| Per-turn starting lane, persisted but NOT on the canonical row/resource projections | `src/server/protocol.ts:165`, `src/server/persistence.ts` `readTurn` (`:797-808`: integer `>= 0` with the sentence at `:804`, `0` omitted) |
| The only producer of a bump, and its undo | `src/plugins/context-compaction.plugin.ts:1059-1113` (`bumpLane` `:1062-1083`, `keepLaneBump` `:1086-1088`, `revertLaneBump` `:1091-1113`); the bump fires at the instruction commit inside `beginSummarize` (`:1155`, call at `:1203`) and the undo runs on every abandon path (`:1225`, `:1248`, `:1329`, `:1578`, `:1628`; the commit keeps it at `:1267`/`:1354`) |

## Proposal

Port it in the order the data flows, so each step is checkable against a fixture the
TypeScript server wrote. Steps 1-4 landed on 2026-11-11 (the second-pass update below records
where), so only the step the port cannot reach is left — the original numbering is kept so the
earlier updates still resolve:

5. the compaction plugin's bump when that stage ports the summarize flow. It has to fire at the
   instruction commit (`src/plugins/context-compaction.plugin.ts:1203`, inside `beginSummarize`)
   and revert on every abandon path (`:1225`, `:1248`, `:1329`, `:1578`, `:1628`), and it has to
   write through the same per-conversation accessor the port's recorder already reads
   (`packages/typecrate/harness/src/store/mod.rs:1677` `context_lane_of`), so live and replay keep
   exactly one source for the number.

Alternatives considered: port only the contract field (rejected — a decoder that accepts
`lane` while the fold ignores it paints a wrong bar, which is the exact live-vs-replay
divergence the port exists to prevent), and wait for the browser wave to define rendering first
(rejected — the contract and the fold are already fixed in TypeScript, and the field is
byte-identical for a session that never compacted).

## Acceptance criteria

- when the summarize flow lands in the port, a compaction raises its conversation's lane exactly
  once, at the instruction commit, and every abandon path reverts it — so a Rust session that
  started on lane 0 reproduces the recorded fixture's lane-1 turn rather than inheriting the
  number from a TypeScript-written document;
- the raised lane is visible to the recorder on that conversation's NEXT event, and a turn that
  starts on it stamps its own non-event segments with it (`laneOfTurn`), which is the pairing the
  fixture pins.

## Tests to add

For the bump, when it lands: the port-side mirror of the TypeScript plugin's lane cases —
`src/plugin/context-compaction.test.ts:3778` ("raises the lane at the instruction commit, before
the pass report"), `:3898` (a purged conversation drops the undo instead of writing a lane onto
it), `:3924` (a refused lane write takes only a diagnostic and the compaction still starts) and
`:3973` ("never touches a lane in exclude mode, where a bump would fragment the bar") — plus a Rust
fold test over a session whose turn starts on lane 0 and ends on lane 1. The lane-1 half is already
vendored at `packages/typecrate/harness/tests/fixtures/lane-compaction/`.

## Out of scope

- No rendering decision for the bar (that is the browser wave, and it groups by the number
  only);
- no new wire field beyond `ContextBlock.lane`: `SessionTurn.lane` and `contextLane` stay
  internal, and the Rust API must not publish them either;
- no lane REST route, and no lane arithmetic in a plugin other than the summarize pass.

## Update (2026-11-11)

- **Re-anchored** (four cites moved): `contextLaneOf` is `src/server/sessions.ts:2745` (was
  `:2735`; its rule comment is `:2718-2744`), the model-run stamp is `:7924-7936` (read at
  `:7934`, written at `:7936`) and the command-recorder stamp is `:6978-6985` (the issue cited
  `:6973`, five lines short); the compaction plugin's lane block is
  `src/plugins/context-compaction.plugin.ts:1059-1113` (was `:1059-1108` — `revertLaneBump` has
  since grown its diagnostic path); `ContextBlock` in the crate is
  `packages/typecrate/harness/src/contract.rs:3029-3059` (was `:2728`; the first pass of this
  update moved it to `:3018-3048`, which is also wrong — `:3018` is `TurnDisplayResponse`, and
  the `ContextBlock` doc comment starts at `:3022`, so the struct body is `:3029-3059`).
- **Re-verified exact, no edit needed**: swagger `src/server/harness.swagger.yaml:8122`
  (`lane:` / `type: integer` / `minimum: 0`), the generated `lane?: number` at
  `src/shared/harness-api.ts:2116` and `src/shared/turn-display.ts:491`, the fold rule at
  `src/server/turn-projector.ts:1409-1449` (`laneOfEvent` `:1435-1439`, `laneOfTurn` `:1441`,
  `laneFieldsOf` `:1449`) and its eight mint sites (`:1564`, `:1588`,
  `:1662`, `:2163`, `:2219`, `:2313`, `:2490`, `:2603`), the recorder writes quoted in the "Why"
  section (`src/server/sessions.ts:7936`, `:6985`), `src/types/index.ts:2505`/`:2578`/`:2938`,
  `src/server/protocol.ts:165`, and `src/harness.ts:5781` (`setThreadContextLane`).
- **Correction, not just anchors: the resync described here has already landed in four of the
  five places the proposal lists.** The port advanced past T4/T5b — T5c, T6, T7a, T7b, T9 and T10
  are done (`packages/typecrate/harness/knowledge.md:34-60`) — and the display lane is now wired
  end to end except for the published field. The paths in the four bullets below are under
  `packages/typecrate/harness/`:
  - **recorded event** — `src/persistence.rs:521-529`: `SessionTurnEvent` carries `lane` at `:528`
    and mints it through `with_lane` (`:544-549`); `LaneStamp` (`:570-585`) is the single rule that
    turns a 0 back into absence, which is what keeps a never-compacted session byte-identical;
  - **recorder** — `src/store/mod.rs:487-510`: `record_event(&event, at, lane)` stamps the record
    before folding and hands the fold the value it just stamped, so live and replay read one
    source; its caller reads the conversation live in `src/store/actions.rs:1096-1111` via
    `context_lane_of` (`src/store/mod.rs:1665-1682`, the doc comment cites
    `sessions.ts:2745` and `:7925-7936`);
  - **fold** — `src/projector.rs:1241-1250`: `apply` takes the event's lane and normalizes it once
    (its comment names `turn-projector.ts:1435 laneOfEvent`); `with_lane` (`:445-458`) inserts the
    key last and only for a non-zero lane, `add_block_with_lane` (`:577-589`) is the two-source
    seam, non-event segments take the turn's starting lane at `:511`, `:542`, `:571`, and the
    `context:set` patch path (`:1431-1454`) still never writes a lane;
  - **durable shapes** — `lane` on the turn record (`src/persistence.rs:612-623`, validated
    `:1194-1198`: a fractional or negative turn lane fails the load, `persistence.ts:1201`'s
    wording), `context_lane` on the thread record (`:848`, camelCased by the struct attribute at
    `:813-814`, so a TypeScript `core.threads[].contextLane` loads), both normalized when a
    document is loaded (a written `0` becomes absence again, so the crate never re-writes a key
    TypeScript never emitted — `src/store/mod.rs:2473-2476`, `:2495`), and the replay path
    re-applies each event's own stamp
    (`src/store/mod.rs:541-543`).
- **What is still missing, and why the issue stays Open**:
  - proposal step 1 — `contract.rs:3029-3059` still has no `lane` field, so acceptance criterion 1
    is not met. The ops carry the key as JSON (`src/projector.rs:453`), so a Rust reader sees the
    number on the wire and cannot represent it in the type; decoding a TypeScript-written block
    drops it;
  - proposal step 5 is **blocked, not skipped**: no plugin hook executes in the port, so nothing
    can raise a lane there (`knowledge.md:60` — "NO plugin hook executes" — and `:61-66`, "The
    plugin HOST is the third unported half … no hook executes");
  - the tests this issue asks for do not exist yet. The recorded fixture does —
    `Temp/fixtures/harness/lane-compaction/` (`durable/events.*.jsonl`, `lane-evidence.json`,
    `turn-displays.json`), and `src/persistence.rs:508` and `:568` cite it in doc comments — but no
    Rust test consumes it. The only lane assertion in the crate is the negative one at
    `tests/http_sessions.rs:1329-1330` ("a conversation that never moved a lane writes no lane key
    at all"), so criterion 2 (two-lane fold parity) and the store round-trip / decode tests are
    unmet;
  - criterion 4 is met by construction for the turn lane (`:1194-1198`) and by the `u64` typing of
    `context_lane` (`:848`), and is untested.
- **The Gap section was reduced to a single bullet the same day this update was written** (the
  landing claims recorded above had already closed two of its three parts, and the log rule
  deletes a closed part from Gap outright rather than annotating it): the **replay** bullet is
  gone (`src/store/mod.rs:541-543` re-applies each event's own stamp) and the
  **durable-lane/snapshot** bullet is gone (`src/persistence.rs:813-848` carries the camelCased
  `context_lane` field, and `src/store/mod.rs:2476`, `:2495` normalize a written `0` back into
  absence when a document is loaded and when the fold is seeded). What is left is the contract
  field. No Evidence or Proposal row was deleted: the TypeScript-side rows still underwrite the
  tests-to-add and the acceptance criteria 2-4 that remain open, and the Proposal keeps its
  data-flow ordering — steps 2-4 are marked landed by the bullets above, and step 1 plus the
  blocked step 5 are the work that is left.
- Status stays **Open**.

## Update (2026-11-11, second pass)

- **Criterion 1 met — the published field landed.**
  `packages/typecrate/harness/src/contract.rs:3029-3076`: `ContextBlock` now carries
  `lane: Option<u64>` at `:3050`, `#[serde(default, skip_serializing_if = "Option::is_none")]`,
  positioned between `section_id` and `name` — the position the generated TypeScript uses
  (`src/shared/harness-api.ts:3320`, inside `ContextBlock` at `:3299`). `Option` is the honest Rust
  spelling of swagger `:8122`'s "absent means lane 0": `None` is what "the producer said nothing"
  looks like, and the crate's `LaneStamp` (`src/persistence.rs:570-585`) is what turns it back into
  the number 0. It is not a patch key: the crate has no `ContextBlockPatch` struct to grow, and the
  fold's `context:set` patch is a map of the mutable fields only (`src/projector.rs:1448-1471`),
  mirroring the TypeScript whitelist (`src/shared/turn-display.ts:630-641`, which has no `lane`
  member). `TurnBlockDetail` flattens the block (`src/contract.rs:3097`), so the segment-detail
  route round-trips the lane with no extra work.
- **A second drift, found and fixed: proposal step 3 had landed only halfway.** The earlier update
  recorded the fold as carrying both lane sources; it did not. `with_lane` was reachable ONLY from
  `add_block_with_lane`, the NON-event seam, so the turn's starting lane reached the prompt,
  instruction and steer segments (`src/projector.rs:516`, `:547`, `:576`) while the two event-driven
  mint sites (`:1343` for `tool`, `:1593` for the `done` answer fallback) called `add_block`
  directly and minted an UNLANED segment. The recorded fixture makes the consequence concrete: a
  post-compaction turn's prompt sat on row 1 while its tool segments — whose events carried
  `lane: 1` — sat on row 0, the exact live-vs-replay divergence the lane exists to prevent. `add_block`
  (`:961-980`) is now the fold's ONE mint point and stamps through `with_lane` (`:450-463`);
  `add_block_with_lane` (`:587-598`) swaps the turn's lane in, delegates, and restores the event
  value, which is what keeps `laneOfEvent` (`src/server/turn-projector.ts:1435`) and `laneOfTurn`
  (`:1441`) distinct while leaving exactly one writer. A lane-0 or unlaned fold still writes no key,
  so every pre-lane document keeps its bytes.
- **Criterion 2 is asserted against recorded bytes.** `packages/typecrate/harness/tests/context_lane.rs`
  (new, 11 tests) folds the recorded session and compares the per-section lane table with
  `turn-displays.json` for BOTH turns: `the_compaction_fixture_folds_to_the_recorded_display_lanes`,
  plus `a_restored_store_replays_the_recorded_lanes` (the checkpoint re-opened, then replayed),
  `the_published_block_carries_the_lane_the_spec_publishes` and
  `a_block_with_no_lane_prints_exactly_the_pre_lane_bytes` (criterion 1's wire shape in both
  directions), `the_compaction_journal_keeps_every_recorded_lane_stamp` (the 337 recorded records
  and their 336 lane stamps read back and re-print byte-identically),
  `the_durable_document_carries_the_turn_and_conversation_lanes`,
  `the_live_ops_carry_the_lane_and_no_patch_ever_does`,
  `a_turn_that_never_moved_a_lane_folds_to_the_pre_lane_bytes` (criterion 3 — the lane-free fold
  reproduces the lane-bearing fold byte for byte once the lane keys are stripped),
  `a_restored_conversation_still_stamps_its_next_event_on_lane_1`,
  `the_events_page_carries_the_stamp_verbatim` and
  `the_snapshot_reader_accepts_a_lane_and_refuses_a_bad_one` (criterion 4).
- **The fixture moved inside the crate.** `tests/fixtures/lane-compaction/` (`MANIFEST.md`,
  `lane-evidence.json`, `turn-displays.json`, `threads-after.json`, `durable/state.json`,
  `durable/events.d8aa98d7-1886-4d3f-a6db-f4869a6623d4.jsonl`, 260 KiB). The copy the first update
  named — `Temp/fixtures/harness/lane-compaction/` — is git-ignored and disposable, so a test that
  read it would pass on one machine and fail on the next; the crate already vendors its
  plugin-catalogue capture the same way (`src/plugins.rs:47-50`).
- **Criterion 4: what refuses, and where the sentences come from.** A bad lane IS refused, at two
  boundaries: `persistence::HarnessThreadRecord::context_lane` is a `u64` (so `-1`, `2.5` and `"2"`
  are decode errors) and `persistence::validate_document` refuses a fractional or negative TURN lane
  with `sessions[i].turns[j].lane must be an integer >= 0.` (`src/persistence.rs:1194-1198`, the
  sentence TypeScript's `src/server/persistence.ts:804` prints). The Rust sentences deliberately
  follow this crate's own document-validation vocabulary, not the snapshot reader's: TypeScript's
  `readThreads` refuses through `readSnapshotInteger` with `… must be a safe integer.` /
  `… must be between 0 and Infinity.` (`src/core/snapshot-validation.ts:90`, `:98`). What parity
  claims is the REFUSAL, not the wording. One asymmetry is recorded rather than fixed:
  `store::restore_threads` (`src/store/mod.rs:2469-2478`) stays tolerant — `core_of` swallows a
  failed decode, so a thread roster carrying a bad `contextLane` restores as an EMPTY roster where
  `readThreads` throws. Making it refuse is a signature decision for the stage that owns the store.
- **Six stale cites re-anchored, and the previous update's "no Evidence row was deleted" is
  superseded.** `src/shared/harness-api.ts:2116` → `:3320` (`:2116` is inside
  `SessionToolSourceResponse`); `src/types/index.ts:2505` → `:2647` (`HarnessThreadRecord` starts at
  `:2608`), `:2938` → `:3080` (`HarnessThreadSnapshot` starts at `:3067`), `:2578` → `:2720-2885`
  (the `HarnessEvent` union, still with no `lane` member); the `contextLane` snapshot rule named
  `persistence.ts:1201` by the crate's own doc comment (`src/persistence.rs:846`) is
  `src/core/snapshot.ts:758-763`, labelled `snapshot.threads` (`:950`) — `src/server/persistence.ts`
  has zero `contextLane` matches. Re-verified exact, no edit: swagger `:8122`,
  `src/shared/turn-display.ts:491` and the `ContextBlockPatch` type at `:630-641`, the fold block at
  `src/server/turn-projector.ts:1409-1449` and its eight mint sites, `src/server/protocol.ts:165`,
  `src/server/sessions.ts:2745` / `:7936`, `src/harness.ts:5781`, and every line of the compaction
  plugin's lane block (`:1062`, `:1086`, `:1091`, `:1203`, `:1225`, `:1248`, `:1267`, `:1329`,
  `:1354`, `:1578`, `:1628`). The closed "Port-side symbols that must gain the field" Evidence row
  and proposal steps 1-4 are deleted per the log rule, as is the closed Gap bullet — which is what
  the header's reduction line records. The Evidence rows that survive underwrite the one open step.
- **Verification.** From `packages/typecrate/harness` with `TMPDIR` at repo-root `Temp/T7`:
  `cargo fmt -- --check` clean; `cargo test --no-fail-fast` **414 passed, 16 failed** across 20
  targets, and all 16 failures are the plugin-catalogue WIP that predates this pass (3 in
  `unittests src/lib.rs` under `plugins::tests`, 13 in `tests/plugins.rs`; they assert a two-plugin
  catalogue and a `contextLimit` default of `100000` while `src/plugins.rs` is an uncommitted
  +584/-87 that ships three plugins and `200000`, with `tests/plugins.rs` UNMODIFIED against HEAD —
  no failure message mentions a lane). `cargo test --test context_lane` alone: **11 passed, 0
  failed**. `cargo clippy --all-targets -- -D warnings` still reports the same six findings, at
  `src/core_pruning.rs:76,80,331,541,778` and `src/plugins.rs:904,1598`, none in a file this pass
  touched.
- **Step 5 stays blocked, not skipped**: no plugin hook executes in the port, so nothing there can
  RAISE a lane — it can now carry, stamp, persist, fold and publish one. Status stays **Open** for
  that reason. No lane REST route appeared, and `SessionTurn.lane` / `contextLane` are still not
  published by the Rust API.
