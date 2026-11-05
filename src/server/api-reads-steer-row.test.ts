// UI-R7 wire-truth guard: a COMPACT TURN ROW publishes each steer entry under the CONTRACT's
// field names, not the projector's internal ones.
//
// WHY THIS FILE EXISTS
// --------------------
// The contract models `TurnSummary.steers[i]` as the CLOSED object `DisplaySteerSummary`
// (../shared/harness-api.ts:1718-1726, generated from ./harness.swagger.yaml:6075-6107):
// `required: [at, promptPreview, promptChars]` and `additionalProperties: false`. The projector's
// row instead carries the submit's verbatim text under `prompt` (./turn-projector.ts:2794-2808,
// typed by the INTERNAL render model ../shared/turn-display.ts:281-296 `DisplaySteerSummary`).
// Copying that list onto the wire therefore shipped one field the spec forbids and omitted the
// two the spec requires, so a client written against the spec read `undefined` for every steer.
//
// ./api-reads.ts `turnRowOf` already renamed the ROW's own `prompt` into that pair; these tests
// pin the same rename for every steer entry, with the EXACT bounded preview and the EXACT
// recorded length, and pin that the row half and the steer half cannot drift apart.
//
// Cross-references (the other three halves of the same contract):
//   - ./api-reads.ts `turnRowOf` / `steerRowOf` — the serializer under test.
//   - ./api.ts:1027 (`turn.upsert` payload) and ./api.ts:3701 (page items) — its only two callers,
//     so a page row and a live frame carry the identical bytes.
//   - ../frontend/display-project.ts `projectSteers` — the client reads `promptPreview` only.
//   - ../frontend/view-test-support.ts `wireRowOf` — the fixture double that mirrors this mapping
//     (its shell case is ../frontend/thread-conversation-shell.test.ts:281).

import type { DisplayProjectContext, TurnProjector } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { steerRowOf, turnRowOf, TURN_PROMPT_PREVIEW_CHARS } from './api-reads';
import { createTurnProjector } from './turn-projector';

const CONTEXT: DisplayProjectContext = { primary: 'one' };

// The same minimal recorded turn the projector suite builds (./turn-projector.test.ts:31): no
// events, so the row's steer list comes ONLY from the record's `steers` audit ring and nothing
// else can move under the assertion.
const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'the task',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_005,
    events: [],
    eventTimes: [],
    ...overrides
});

// A projector over that record, folded exactly once — the state `./api.ts` reads for a page row.
const projectorOf = (turn: SessionTurn): TurnProjector => createTurnProjector(turn, CONTEXT);

describe('turnRowOf — steer entries are projected to the DisplaySteerSummary contract', () => {
    it('ships promptPreview + promptChars for a steer instead of the projector prompt', () => {
        const row = turnRowOf(projectorOf(turnOf({ steers: [{ id: 'st-1', at: 1_002, prompt: 'keep going' }] })), 'turn-1');

        // The whole entry, exactly: the contract's names, the same bounded text, the EXACT length.
        expect(row.steers).toEqual([{ id: 'st-1', at: 1_002, promptPreview: 'keep going', promptChars: 10 }]);

        // Closed object (`additionalProperties: false`, swagger:6083): the internal `prompt` is
        // gone, and nothing outside the contract's set is present.
        const entry = row.steers![0] as unknown as Record<string, unknown>;
        expect('prompt' in entry).toBe(false);
        expect(Object.keys(entry).sort()).toEqual(['at', 'id', 'promptChars', 'promptPreview']);

        // The row's own pair keeps the identical spelling, at the identical bound.
        expect(row.promptPreview).toBe('the task');
        expect(row.promptChars).toBe(8);
    });

    it('bounds a long steer preview and keeps promptChars the exact recorded length', () => {
        // 500 characters: far past the row bound, which is the whole reason a pair exists.
        const long = 'y'.repeat(500);
        const row = turnRowOf(projectorOf(turnOf({ steers: [{ id: 'st-9', at: 1_003, prompt: long }] })), 'turn-1');

        // `previewText` keeps `limit - 1` characters and closes with one ellipsis (./turn-projector.ts:150-156),
        // so the preview is EXACTLY `TURN_PROMPT_PREVIEW_CHARS` long — the same figure the row's own
        // prompt is bounded at (./api-reads.ts:289), which is what keeps a page of rows bounded.
        expect(row.steers![0].promptPreview).toBe(`${'y'.repeat(TURN_PROMPT_PREVIEW_CHARS - 1)}\u2026`);
        expect(row.steers![0].promptPreview.length).toBe(TURN_PROMPT_PREVIEW_CHARS);
        expect(row.steers![0].promptChars).toBe(500);
    });

    it('keeps every other steer field verbatim and never renumbers the ring', () => {
        const row = turnRowOf(
            projectorOf(
                turnOf({
                    threadId: 'thread-1',
                    steers: [
                        // A steer delivered to a DELEGATED child: `threadId` rides the entry so the
                        // board routes it into that conversation, never as the parent prompt.
                        { id: 'st-a', at: 1_002, prompt: 'deeper please', threadId: 'thread-2', references: [{ turnId: 'turn-0', label: 'IT1' }] },
                        // A pre-T13 record has no id; the entry must stay id-less rather than invent one.
                        { at: 1_004, prompt: 'no id here' }
                    ]
                })
            ),
            'turn-1'
        );

        expect(row.steers).toEqual([
            {
                id: 'st-a',
                at: 1_002,
                threadId: 'thread-2',
                references: [{ turnId: 'turn-0', label: 'IT1' }],
                promptPreview: 'deeper please',
                promptChars: 13
            },
            { at: 1_004, promptPreview: 'no id here', promptChars: 10 }
        ]);
    });

    it('omits steers entirely for a row with no submits and leaves the row prompt pair intact', () => {
        const row = turnRowOf(projectorOf(turnOf()), 'turn-1');

        // Absent, not empty: the projector itself omits the key, and the wire row must not invent one.
        expect('steers' in (row as unknown as Record<string, unknown>)).toBe(false);
        expect(row.promptPreview).toBe('the task');
        expect(row.promptChars).toBe(8);
    });

    it('maps one entry with steerRowOf so a page row and a live frame cannot diverge', () => {
        // `steerRowOf` is the single mapping both callers reach (./api.ts:1027 and :3701); pinning it
        // directly means a future serializer that forgot the per-entry pass fails here, not in a UI.
        expect(steerRowOf({ id: 'st-1', at: 1_002, prompt: 'keep going' })).toEqual({
            id: 'st-1',
            at: 1_002,
            promptPreview: 'keep going',
            promptChars: 10
        });

        // An entry with no text still answers with the pair the contract requires.
        expect(steerRowOf({ at: 1_006 })).toEqual({ at: 1_006, promptPreview: '', promptChars: 0 });
    });
});
