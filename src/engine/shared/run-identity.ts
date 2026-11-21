// THE invocation-RUN key: one definition of "which RUN is this id talking about", shared by every
// layer that joins an invocation id to anything (W19, 2026-11-17).
//
// WHY A RUN KEY EXISTS. An invocation id is `String(++runSequence)` from a counter that is PER
// PROCESS (`../harness.ts` `runSequence`; restore only ever RAISES it, and `reserveIdentity`
// leases raises for a lane worker). A restarted harness therefore mints `15` again for a DIFFERENT
// run, and a lane worker mints from its own counter while the parent process is still running. An
// id alone can never say WHICH run it names; `HarnessThread.epoch` (`../types/index.ts`, minted in
// `../core/agent-limits.ts` `HARNESS_PROCESS_EPOCH`) is the only fact on a frame that can.
//
// THE RULE, in one sentence: a run is `id + "\0" + epoch` when the producer named an epoch, and the
// BARE id when it did not. Bare-keyed producers are not an edge case — they are every record written
// before the epoch field existed, and every hand-written reporter — which is why the fallback is
// part of the rule and not an exception to it. A document with no epoch anywhere therefore has keys
// that are already bare ids, and resolves EXACTLY as it does today: this is additive, not a
// migration (no re-keying on load, no version bump, no restore behaviour change).
//
// WHAT THE COMPOSITE IS ALLOWED TO TOUCH. The run key is a JOIN key only. Every wire field, model
// -facing tool result and persisted identity that carries a bare invocation id today still carries
// the bare id: the epoch half is stripped at the boundary by `invocationIdOfRunKey`
// (`../server/api-reads.ts` is the precedent — its roster readers had to strip it). What MAY carry
// the epoch is a private join map (`Session.invocationThreads`, the label joins, the harness's
// result ledger) and a NEW optional persisted key that names the epoch on its own (a plain string,
// never the composite).
//
// WHY THIS FILE, AND WHY NOT `server/protocol.ts` (where the rule first shipped). Four layers
// consume it and only one of them may import the server tree:
//   - `../server/protocol.ts`       — re-exports these names (its importers are unchanged);
//   - `../server/sessions.ts`       — the store's invocation/label joins;
//   - `../harness.ts`               — the runtime result ledger; it may not import `./server/*`
//                                      (the convention stated at its `HARNESS_PROCESS_EPOCH` import);
//   - `./agent-results.ts`          — the block projection (isomorphic);
//   - `../frontend/ui/*`            — the browser board and the transcript dialog; the frontend
//                                      imports nothing from `../core/*` or `../server/*` at runtime.
// A dependency-free leaf in `shared/` is the only place all five can reach. It is deliberately NOT
// re-exported from `./index.ts`: `invocationRunKeyOf` is already published through
// `../server/protocol.ts`, and a second star-export of one name across two barrels is how TS2308
// ambiguity appears (`./index.ts` states the same rule for `./harness-api.ts`). Import it by path.
//
// Cross-references:
//   - ../server/protocol.ts            — R19 note, and the published re-export
//   - ../server/sessions.ts            — `noteInvocationThread`, `labelJoinsOf`
//   - ../server/turn-projector.ts      — the display fold's row resolution (rule (0) + R18/R19)
//   - ../harness.ts                    — `invocationRecords`, `archiveInvocation`, `restore`
//   - ./agent-results.ts               — `blockForThread` (a block is ONE RUN)
//   - ../frontend/ui/turns.ts          — `runKeyOf`, the browser's mirror of the same rule
//   - ../frontend/ui/thread-transcript.ts — the related-event attribution join

// The separator inside a run key. A NUL cannot occur in a runtime invocation id (the runtime mints
// decimal counters and opaque `branch-N` ids) and is the same composite-key separator the board
// already uses (`../frontend/ui/turns.ts` `runKeyOf`, `../server/sessions.ts`), so a bare id can
// never parse as somebody else's run key.
export const INVOCATION_RUN_KEY_SEPARATOR = '\u0000';

// The key of ONE invocation RUN: bare id when the producer named no epoch (a record written before
// `HarnessThread.epoch` existed, or a hand-written reporter), `id\0epoch` when it did.
export const invocationRunKeyOf = (invocationId: string, epoch: string | undefined): string =>
    epoch === undefined ? invocationId : `${invocationId}${INVOCATION_RUN_KEY_SEPARATOR}${epoch}`;

// The bare invocation id a run key carries — the shape every wire field, tool and client join uses.
// An epoch-less (legacy) key is already bare and comes back unchanged.
export const invocationIdOfRunKey = (runKey: string): string => {
    const index = runKey.indexOf(INVOCATION_RUN_KEY_SEPARATOR);

    return index === -1 ? runKey : runKey.slice(0, index);
};

// True when two KNOWN epochs name DIFFERENT processes. An `undefined` on either side is "the
// producer said nothing", never "the producer is a different process" — the same one-sided rule
// `../server/turn-projector.ts` `isEpochBoundary` applies, and the reason a pre-change record keeps
// binding instead of losing its join. Equality is likewise never a boundary by itself: two frames of
// one run share an epoch and may still be two runs; it is the DIFFERENCE that separates them.
export const isRunEpochMismatch = (left: string | undefined, right: string | undefined): boolean =>
    left !== undefined && right !== undefined && left !== right;
