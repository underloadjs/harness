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
  the TypeScript server drops the key;
- **replay the same ops after a restart.** The fold's lane comes from the recorded event, so a
  port without the stamp produces a different (single-row) bar for the same `state.json` /
  `events.jsonl` a TypeScript server wrote;
- **state the durable per-conversation lane.** The thread record and the host-thread snapshot
  gained `contextLane`, and `readThreads` accepts the key; a port that refuses unknown
  snapshot keys cannot even load a document the TypeScript server wrote.

## Why it is the way it is

The port is staged (`packages/typecrate/harness/knowledge.md`, "Stage map"), and this field
postdates the stages that already shipped, including T4 (the projector) and T5b (the
session-domain routes). Nothing in the port decides independently what a lane means: the
TypeScript side is the source of truth, and the swagger spec is the source of truth for the
contract. So the drift is expected and bounded — it is a pending resync, not a design
disagreement — and it is recorded here so the resync is not re-derived from scratch.

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
| The stamp is written by the recorder at record time, read live per event | `src/server/sessions.ts:2735` (`contextLaneOf`), `:7924` (model-run recorder), `:6973` (command recorder) |
| Durable per-conversation lane, with its strict snapshot whitelist and normalization (`0` never persisted) | `src/types/index.ts:2505` (record), `:2938` (host-thread snapshot), `src/core/snapshot.ts` `readThreads` (`contextLane` in the key list + non-negative-integer read), `src/harness.ts:5781` (`setThreadContextLane`) |
| Per-turn starting lane, persisted but NOT on the canonical row/resource projections | `src/server/protocol.ts:165`, `src/server/persistence.ts` `readTurn` (integer `>= 0`, `0` omitted) |
| The only producer of a bump, and its undo | `src/plugins/context-compaction.plugin.ts:1059-1108`, called at the instruction commit in `beginSummarize` and undone on every abandon path |
| Port-side symbols that must gain the field | `packages/typecrate/harness/src/contract.rs:2728` (`ContextBlock`), `packages/typecrate/harness/src/projector.rs` (the fold), plus the store's recorder and the snapshot reader in `store/**` / `persistence.rs` |

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
`src/server/turn-projector.test.ts`, "context bar (R6/R8)" lane cases), a store round-trip
test (thread `contextLane`, turn `lane`, event lanes survive a restart), and a contract decode
test for `ContextBlock.lane`.

## Out of scope

- No rendering decision for the bar (that is the browser wave, and it groups by the number
  only);
- no new wire field beyond `ContextBlock.lane`: `SessionTurn.lane` and `contextLane` stay
  internal, and the Rust API must not publish them either;
- no lane REST route, and no lane arithmetic in a plugin other than the summarize pass.
