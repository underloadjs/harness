# 0017 — The display lane (context bar rows) landed in TypeScript and is not in the Rust port

> **Status:** Open
> **Severity:** Minor (drift risk — the Rust port is a faithful-port target, so an unported
> contract field is a divergence a later stage has to re-derive by hand)
> **Area:** `packages/typecrate/harness` (port target); `src/shared/turn-display.ts`,
> `src/server/protocol.ts`, `src/server/sessions.ts`, `src/server/turn-projector.ts`,
> `src/core/snapshot.ts`, `src/harness.ts`, `src/plugins/context-compaction.plugin.ts`
> **Date opened:** 2026-11-10

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

- **represent a lane on a context segment.** `ContextBlock` has no `lane`, so a ported fold
  cannot put two segments on different rows, and a decoder for a session document written by
  the TypeScript server drops the key.

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
TypeScript interface has no `lane` member at all (`src/types/index.ts:2578` declares the union
without it, and the fold therefore reads it through a cast,
`src/server/turn-projector.ts:1435-1439`). A port that mirrors only the published
`ContextBlock.lane` still cannot replay the bar: the event stamp is the fold's INPUT, so the
port's recorded-event type must carry an optional `lane` on every event it folds and pass it
through the journal and the document verbatim, exactly as TypeScript does — the absence of a
generated field is not permission to drop the key.

## Evidence

| Fact | Where |
|---|---|
| Published field: `ContextBlock.lane`, integer, `minimum: 0`, absent ⇒ lane 0, mint-assigned and immutable (not a patch key) | `src/server/harness.swagger.yaml:8122`, generated into `src/shared/harness-api.ts:2116` and `src/shared/turn-display.ts:491` |
| The TypeScript fold's rule: an event-driven segment takes the event's lane, a non-event segment (`system` / `prompt` / `steer`) takes the turn's starting lane, `0` is never written, and a `context:set` patch never carries a lane | `src/server/turn-projector.ts:1409-1449` (`laneOfEvent` / `laneOfTurn` / `laneFieldsOf`), mints at `:1564`, `:1588`, `:1662`, `:2163`, `:2219`, `:2313`, `:2490`, `:2603` |
| The stamp is written by the recorder at record time, read live per event | `src/server/sessions.ts:2745` (`contextLaneOf`, its rule comment `:2718-2744`), `:7924-7936` (model-run recorder: the rule at `:7924-7933`, the live read at `:7934`, the write at `:7936`), `:6978-6985` (command recorder, one rule for both) |
| Durable per-conversation lane, with its strict snapshot whitelist and normalization (`0` never persisted) | `src/types/index.ts:2505` (record), `:2938` (host-thread snapshot), `src/core/snapshot.ts` `readThreads` (`contextLane` in the key list + non-negative-integer read), `src/harness.ts:5781` (`setThreadContextLane`) |
| Per-turn starting lane, persisted but NOT on the canonical row/resource projections | `src/server/protocol.ts:165`, `src/server/persistence.ts` `readTurn` (integer `>= 0`, `0` omitted) |
| The only producer of a bump, and its undo | `src/plugins/context-compaction.plugin.ts:1059-1113` (`bumpLane` `:1062-1083`, `keepLaneBump` `:1086-1088`, `revertLaneBump` `:1091-1113`); the bump fires at the instruction commit inside `beginSummarize` (`:1155`, call at `:1203`) and the undo runs on every abandon path (`:1225`, `:1248`, `:1329`, `:1578`, `:1628`; the commit keeps it at `:1267`/`:1354`) |
| Port-side symbols that must gain the field | `packages/typecrate/harness/src/contract.rs:3029-3059` (`ContextBlock` — the one symbol still without `lane`; its doc comment starts at `:3022`); the fold, the recorder and the snapshot reader already carry it, as the 2026-11-11 update records |

## Proposal

Port it in the order the data flows, so each step is checkable against a fixture the
TypeScript server wrote:

1. `contract.rs`: add `lane: Option<u64>` to `ContextBlock` (and keep it out of the block-patch
   type), matching swagger `:8122` (`integer`, `minimum: 0`);
2. the store's event recorder: stamp the live per-conversation lane at record time, omitting
   `Some(0)`;
3. `projector.rs`: copy the two-source rule above (`laneOfEvent` / `laneOfTurn`) and the "never
   patch a lane" invariant;
4. the persistent shapes: `contextLane` on the thread record and on the host-thread snapshot,
   `lane` on the turn record, with `0` normalized away in both directions;
5. the compaction plugin's bump when that stage ports the summarize flow.

Alternatives considered: port only the contract field (rejected — a decoder that accepts
`lane` while the fold ignores it paints a wrong bar, which is the exact live-vs-replay
divergence the port exists to prevent), and wait for the browser wave to define rendering first
(rejected — the contract and the fold are already fixed in TypeScript, and the field is
byte-identical for a session that never compacted).

## Acceptance criteria

- `packages/typecrate/harness` spec-sync is recorded as done: `ContextBlock` carries `lane`,
  with the same `minimum: 0` / absent-means-zero reading as swagger `:8122`;
- a `state.json` + `events.jsonl` written by the TypeScript server after one summarize
  compaction folds to the same per-section `lane` values in Rust as in TypeScript — asserted
  against a recorded fixture, not restated;
- a turn whose events carry no `lane` folds to ops byte-identical to the pre-feature output;
- the Rust snapshot reader accepts `contextLane` on a host thread and refuses a
  non-integer/negative one, like `readThreads`.

## Tests to add

In the Rust crate: a projector test over a two-lane fixture (mirror of
`src/server/turn-projector.test.ts:1292`, "context bar (R6/R8)", and its dedicated lane block at
`:2175`, "context-bar display lanes (C1)", which holds the two-row case); a store round-trip test
(thread `contextLane`, turn `lane`, event lanes survive a restart); and a contract decode test for
`ContextBlock.lane`.

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
