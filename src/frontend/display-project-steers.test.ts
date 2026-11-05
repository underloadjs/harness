// UI-R7 wire-truth guard (CLIENT half): a steer reaches the conversation from the CONTRACT
// spelling on the row, and from nothing else.
//
// WHY THIS FILE EXISTS
// --------------------
// `TurnSummary.steers[i]` is the CLOSED object `DisplaySteerSummary`
// (../shared/harness-api.ts:1718-1726, generated from ../server/harness.swagger.yaml:6075-6107):
// `required: [at, promptPreview, promptChars]`, `additionalProperties: false`. The server's row
// serializer used to rename only the ROW's own `prompt` and copy the projector's steer list
// verbatim, so the wire carried the projector's internal `prompt` and no `promptPreview` at all.
// Nothing failed at the boundary — `./display-project.ts` `projectSteers` had papered over it with
// a DUAL read (`promptPreview ?? prompt`), which hid the divergence instead of closing it.
//
// The serializer is fixed (../server/api-reads.ts `turnRowOf` / `steerRowOf`, pinned by
// ../server/api-reads-steer-row.test.ts) and the dual read is GONE. These assertions are the
// client side of the same fact:
//
//   1. THE FIXTURE DOUBLE SPEAKS THE CONTRACT. `./view-test-support.ts` `wireRowOf` mirrors the
//      server serializer, so a shell fixture states the bytes the real route states — including
//      the per-entry rename. Asserted here as a KEY LIST, because "the old spelling is absent" is
//      the half a dual read could never prove.
//   2. THE RENDER MODEL STILL GETS ITS `prompt`. A tile renders `steer.prompt`
//      (./ui/turns.ts:1439 `markdownFragment(steer.prompt)`), and the render model keeps that name
//      (../shared/turn-display.ts:281-296); the projection is a RENAME, not a rename-plus-drop, so
//      a steer painted inside a running conversation is proof the pair survived the round trip.
//   3. THE OLD SPELLING IS NOT HONORED ANY MORE. An entry that carries only `prompt` projects to
//      an empty preview: reading it would re-open the divergence this pass closed.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts src/frontend/display-project-steers.test.ts

import type { TurnSummary as WireTurnSummary } from '../shared/harness-api';
import type { TurnSummary } from '../shared/turn-display';
import { describe, expect, it } from 'vitest';
import { projectRow } from './display-project';
import { wireRowOf } from './view-test-support';

/**
 * The route transport, exactly: the handler `JSON.stringify`s the row `turnRowOf` built and the
 * client parses it back, so a round trip through JSON IS the wire — and a key the serializer
 * deleted is GONE from the body. That is what makes the key-list assertions below evidence about
 * absence rather than about `undefined` placeholders.
 */
const routeOf = <T>(value: T): WireTurnSummary => JSON.parse(JSON.stringify(value)) as WireTurnSummary;

// A settled row spelled the way the PROJECTOR mints it (../server/turn-projector.ts:2846-2867):
// the verbatim `prompt` on the row, and the same name on every steer entry (:2794-2808).
const compiledRow = (overrides: Partial<TurnSummary> = {}): TurnSummary =>
    ({
        id: 'turn-1',
        index: 0,
        prompt: 'the task',
        status: 'done',
        state: 'done',
        updatedAt: 1_005,
        sectionCount: 1,
        stepCount: 0,
        activeAgents: [],
        blocks: [],
        ...overrides
    }) as TurnSummary;

describe('wireRowOf + projectRow — one steer entry, record to wire to render model', () => {
    const compiled = compiledRow({ steers: [{ id: 'st-1', at: 1_002, prompt: 'keep going' }] });

    it('the fixture double ships the contract spelling and drops the projector one', () => {
        const wire = routeOf(wireRowOf(compiled));

        // The whole entry, exactly: the pair the spec requires, and the submit's own id.
        expect(wire.steers).toEqual([{ id: 'st-1', at: 1_002, promptPreview: 'keep going', promptChars: 10 }]);

        // Closed object (swagger:6083): the key set is the contract's set and NOTHING else, so the
        // projector's `prompt` cannot ride along on either the row or an entry.
        expect(Object.keys(wire).sort()).not.toContain('prompt');
        expect(Object.keys(wire.steers![0] as unknown as Record<string, unknown>).sort()).toEqual([
            'at',
            'id',
            'promptChars',
            'promptPreview'
        ]);

        // The row half keeps the identical pair, so the two halves of one row cannot drift.
        expect(wire.promptPreview).toBe('the task');
        expect(wire.promptChars).toBe(8);
    });

    it('the row projection renames the preview back to the render model prompt', () => {
        const view = projectRow(routeOf(wireRowOf(compiled)));

        // What the tile draws (./ui/turns.ts:7608-7616): the submit's text under `prompt`, with its
        // identity and timestamp intact, and no `promptChars` leak into the render model.
        expect(view.steers).toEqual([{ id: 'st-1', at: 1_002, prompt: 'keep going' }]);

        // The row's own preview is marked as a preview, beside the EXACT length — the figure a tile
        // needs to say "show more" honestly instead of assuming the row text is complete.
        expect(view.prompt).toBe('the task');
        expect(view.promptPreview).toBe('the task');
        expect(view.promptChars).toBe(8);
        expect(view.promptIsPreview).toBe(true);
    });

    it('a steer entry with only the old spelling no longer paints text', () => {
        // The dual read this pass removed used to fall back to `prompt`. Reading it again would put
        // the client out of step with the spec, so the fallback is asserted ABSENT here.
        const legacy = routeOf({ ...wireRowOf(compiledRow()), steers: [{ at: 1_004, prompt: 'old spelling' }] });

        expect(projectRow(legacy).steers).toEqual([{ at: 1_004, prompt: '' }]);
    });

    it('omits steers for a row with no submits rather than sending an empty list', () => {
        const wire = routeOf(wireRowOf(compiledRow()));

        expect('steers' in (wire as unknown as Record<string, unknown>)).toBe(false);
        expect(projectRow(wire).steers).toBeUndefined();
    });
});
