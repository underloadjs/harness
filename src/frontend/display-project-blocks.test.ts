// ONE context-bar segment: the projector's record, through the server route, into the
// render model (U6 context-block contract parity).
//
// WHAT THIS PINS DOWN, and the bug it closes:
//
//   1. THE ROUTE TRANSPORTS THE PROJECTOR VERBATIM. `getSessionTurnDisplay`
//      (../server/api.ts:3741-3768) and `getSessionTurnBlock` (../server/api.ts:3807-3823)
//      only CAST `projector.display()` / `store.blockDetail()` (`as unknown as`), so the
//      JSON body IS the projector's own `ContextBlock` record
//      (../shared/turn-display.ts:434-553) - field names included. That is why the display
//      name on the wire is `name`, never a renamed `label`: the closed key set a system
//      segment actually answers with is
//      `at, chars, entries, id, inPrompt, kind, name, sectionId, sessionId, turnId`
//      (../server/api.test.ts:2195-2196 and :2202-2212) - `label` is not in it.
//
//   2. THE CONTRACT USED TO DECLARE NONE OF THAT. The generated record
//      (../shared/harness-api.ts `ContextBlock`, generated from
//      ../server/harness.swagger.yaml `ContextBlock`) required `label` and carried no
//      `name`, no `at`, `endedAt`, `durationMs`, `argsChars`, `resultChars`, or
//      `inPrompt`, and it demanded a `state` a non-tool segment never sends. A projector
//      member still satisfied it (an object with extra properties is not an error), so
//      NOTHING failed at the boundary - ./display-project.ts simply had no field to read,
//      and every figure the bar is written to draw was dropped: the measured duration
//      (../shared/turn-display.ts:486-501), the args/result split (:513-522), the replay
//      flag (:523-535), and the recorded name. The spec now carries them; the assertions
//      below are the round trip that proves the client reads them.
//
//   3. ABSENCE IS A VALUE, NOT A ZERO. A `user`/`system` segment has no recorded span, a
//      running call has no `endedAt`, and an event with no timestamp has no `at`
//      (../shared/turn-display.ts:476-485). Copying those as `0` would paint midnight and
//      "0ms", and `view-context.ts:275` `contextBlockCharsOf` / :293 `contextBlockDurationOf`
//      both distinguish "no figure" from a figure - so the absent case is asserted by KEY
//      LIST, not by a loose check.
//
//   4. STILL METADATA ONLY. A segment carries no text, no recorded events, and no bytes:
//      those stay one identified read away at the block detail route
//      (../server/harness.swagger.yaml `TurnBlockDetail`). The full projected key set is
//      asserted below, so a "fix" that ships an `events` array or a base64 `data` field on
//      the bar fails here.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts src/frontend/display-project-blocks.test.ts

import type { ContextBlock as WireContextBlock, TurnSection as WireTurnSection } from '../shared/harness-api';
import type { ContextBlock } from '../shared/turn-display';
import { describe, expect, it } from 'vitest';
import { projectBlock, projectSection } from './display-project';

const T = 1_700_000_000_000;

/**
 * The route's transport, exactly: the handler `JSON.stringify`s the very record it was
 * handed (../server/api.ts:3767 and :3820 `json(200, response, ...)`) and the client parses
 * it back. A round trip through JSON IS the server projection - no rename, no
 * re-derivation - and a key the projector left out is GONE from the body, which is what
 * makes the key-list assertions below real evidence about absence rather than about
 * `undefined` placeholders.
 */
const routeOf = <T>(value: T): WireContextBlock => JSON.parse(JSON.stringify(value)) as WireContextBlock;

// A settled tool segment, spelled the way the projector mints it: `name`
// (../server/turn-projector.ts:2015), `argsChars` at open (:2018), then `chars =
// argsChars + resultChars` and `resultChars` when the result lands (:2136-2137),
// `inPrompt: true` (:2138), and the STEP-state vocabulary `state: 'ok'` (:2482) - the same
// figure the wire answers with for a tool segment (./view.test.ts:926). The figures below
// are the ones this file asserts: args 23 + result 11 = 34 chars, 800ms.
const toolBlock: ContextBlock = {
    kind: 'tool',
    id: '2-tool-7',
    turnId: 't1',
    sectionId: 't1:2',
    name: 'read',
    at: T,
    endedAt: T + 800,
    durationMs: 800,
    chars: 34,
    argsChars: 23,
    resultChars: 11,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9
};

// A reasoning segment: its span is the recorded stream window (1500ms here,
// ../shared/turn-display.ts:495-497) and `inPrompt` is FALSE, because thinking is streamed
// and recorded but never replayed into the next request (:531-533, and the projector's own
// mint at ../server/turn-projector.ts:1933).
const reasoningBlock: ContextBlock = {
    kind: 'reasoning',
    id: '2-reasoning-3',
    turnId: 't1',
    sectionId: 't1:2',
    name: 'reasoning',
    at: T,
    endedAt: T + 1_500,
    durationMs: 1_500,
    chars: 284,
    inPrompt: false,
    eventFrom: 3,
    eventTo: 6
};

// The prompt segment: a submitted prompt has no recorded span and no event evidence
// (../shared/turn-display.ts:498-499 and :540-544), so it carries no `at`, `endedAt`,
// `durationMs`, `eventFrom`, `eventTo`, and no `state`.
const promptBlock: ContextBlock = {
    kind: 'user',
    id: '2-user-prompt',
    turnId: 't1',
    sectionId: 't1:2',
    name: 'prompt',
    chars: 42,
    inPrompt: true
};

describe('projectBlock - the record the route actually transports', () => {
    it('accepts a real projector segment as the wire record, with no cast', () => {
        // THE CONTRACT-LEVEL ASSERTION, made by the compiler: the projector's own record is
        // assignable to the generated closed record. While the spec demanded a `label`,
        // required a `state` a system segment never sends, and named no metadata field,
        // this line could not compile.
        const accepted = toolBlock satisfies WireContextBlock;

        expect(accepted.name).toBe('read');
        expect(accepted.durationMs).toBe(800);
        expect(accepted.inPrompt).toBe(true);

        const systemFromTheRoute = promptBlock satisfies WireContextBlock;

        expect(systemFromTheRoute.state).toBeUndefined();
    });

    it('keeps every measured figure of a settled tool segment through the route', () => {
        const projected = projectBlock(routeOf(toolBlock));

        // Exact and complete: the duration the record measured, the args/result split, and
        // the recorded name all survive the wire.
        expect(projected).toStrictEqual({
            kind: 'tool',
            id: '2-tool-7',
            turnId: 't1',
            sectionId: 't1:2',
            name: 'read',
            chars: 34,
            inPrompt: true,
            state: 'ok',
            at: T,
            endedAt: T + 800,
            durationMs: 800,
            argsChars: 23,
            resultChars: 11,
            eventFrom: 7,
            eventTo: 9
        });
    });

    it('draws a reasoning segment as 1500ms of text that was never replayed', () => {
        const projected = projectBlock(routeOf(reasoningBlock));

        expect(projected).toStrictEqual({
            kind: 'reasoning',
            id: '2-reasoning-3',
            turnId: 't1',
            sectionId: 't1:2',
            name: 'reasoning',
            chars: 284,
            // The wire figure is READ; the next case shows the fallback rule only speaks
            // when the record does not.
            inPrompt: false,
            at: T,
            endedAt: T + 1_500,
            durationMs: 1_500,
            eventFrom: 3,
            eventTo: 6
        });
    });

    it('uses the published `inPrompt` over the fallback rule, in both directions', () => {
        // A reasoning segment a producer marks as replayed: the client states what the
        // record says instead of imposing a per-kind rule on a published figure.
        expect(projectBlock(routeOf({ ...reasoningBlock, inPrompt: true })).inPrompt).toBe(true);

        // A producer that OMITS the flag falls back to the projector's total rule
        // (../shared/turn-display.ts:523-535), so the bar still never counts thinking as
        // prompt text: tool -> true, reasoning -> false.
        const { inPrompt: _toolFlag, ...toolWithoutFlag } = toolBlock;
        const { inPrompt: _reasoningFlag, ...reasoningWithoutFlag } = reasoningBlock;

        expect(projectBlock(routeOf(toolWithoutFlag)).inPrompt).toBe(true);
        expect(projectBlock(routeOf(reasoningWithoutFlag)).inPrompt).toBe(false);
    });

    it('leaves an unrecorded time unknown instead of inventing a zero', () => {
        const projected = projectBlock(routeOf(promptBlock));

        // No `at`, no `endedAt`, no `durationMs`, no `state`. `toStrictEqual` fails on a key
        // that exists with an `undefined` value and the key list fails on a synthesized `0`,
        // which together is the difference between "the record says nothing" and "this took
        // no time" (`view-context.ts:293` `contextBlockDurationOf` reads exactly that).
        expect(projected).toStrictEqual({
            kind: 'user',
            id: '2-user-prompt',
            turnId: 't1',
            sectionId: 't1:2',
            name: 'prompt',
            chars: 42,
            inPrompt: true
        });
        expect(Object.keys(projected).sort()).toEqual([
            'chars',
            'id',
            'inPrompt',
            'kind',
            'name',
            'sectionId',
            'turnId'
        ]);
    });

    it('adds no payload to a bar segment, only the closed metadata set', () => {
        const projected = projectBlock(routeOf(toolBlock));

        // METADATA ONLY (../server/harness.swagger.yaml `ContextBlock`): the recorded text,
        // the event pair, and any bytes ride the detail route, so one segment stays a
        // fixed-size record no matter how long the conversation gets.
        expect(Object.keys(projected).sort()).toEqual([
            'argsChars',
            'at',
            'chars',
            'durationMs',
            'endedAt',
            'eventFrom',
            'eventTo',
            'id',
            'inPrompt',
            'kind',
            'name',
            'resultChars',
            'sectionId',
            'state',
            'turnId'
        ]);
        expect(projected).not.toHaveProperty('events');
        expect(projected).not.toHaveProperty('args');
        expect(projected).not.toHaveProperty('result');
        expect(projected).not.toHaveProperty('data');
    });

    it('reads the name as name, then the older label, then the kind - never a silent rename', () => {
        // A record that publishes only `label` (the older spelling the closed set still
        // allows, ../server/harness.swagger.yaml `ContextBlock.label`) still answers with the
        // recorded name instead of collapsing to the kind.
        expect(projectBlock(routeOf({ ...toolBlock, name: undefined, label: 'read' })).name).toBe('read');

        // BOTH spellings: the projector's `name` wins, so a stale `label` can never
        // overwrite a recorded name.
        expect(projectBlock(routeOf({ ...toolBlock, name: 'write', label: 'read' })).name).toBe('write');

        // NEITHER: the fallback is the kind, because `name` is required in the render model
        // (../shared/turn-display.ts:475) and an empty string renders as nothing.
        expect(projectBlock(routeOf({ ...promptBlock, name: undefined })).name).toBe('user');

        // An empty name IS a published value: `??` is nullish, not falsy.
        expect(projectBlock(routeOf({ ...promptBlock, name: '' })).name).toBe('');
    });

    it('maps a section-vocabulary state through the one mapping, and passes the step one through', () => {
        // The wire ref is the STEP vocabulary the projector mints (`running` / `ok`,
        // ../server/turn-projector.ts:2022 and :2482). A record that carries a
        // SECTION-vocabulary value anyway (`done` / `streaming`,
        // ../shared/turn-display.ts:189) is translated here so no renderer compares the two.
        expect(projectBlock(routeOf({ ...toolBlock, state: 'done' })).state).toBe('ok');
        expect(projectBlock(routeOf({ ...toolBlock, state: 'streaming' })).state).toBe('running');
        expect(projectBlock(routeOf({ ...toolBlock, state: 'running' })).state).toBe('running');

        // A settled failure keeps its own verdict, and is never re-derived from anything else.
        expect(projectBlock(routeOf({ ...toolBlock, state: 'error' })).state).toBe('error');
    });

    it('keeps `callId` as the renderer handle it is, and omits it when the record does', () => {
        // The wire publishes `callId` (../shared/harness-api.ts `ContextBlock.callId`) and the
        // projector's render model does NOT declare one (../shared/turn-display.ts:434-553), so
        // the value rides the projection as an extra key and is read through the narrowed
        // shape here. Reported to the model owner rather than widened silently.
        const withHandle = projectBlock(routeOf({ ...toolBlock, callId: 'call_1' })) as ContextBlock & { callId?: string };

        expect(withHandle.callId).toBe('call_1');

        // Absent on the record, absent in the model: no empty-string handle is minted for a
        // segment that has no call behind it.
        expect('callId' in projectBlock(routeOf(promptBlock))).toBe(false);
    });

    it('carries the lane the record publishes, and mints none when the record does not (C2)', () => {
        // C2: `lane` is WHICH STACKED ROW of the one bar a segment belongs to
        // (../shared/turn-display.ts:474-491, and the spec's `ContextBlock.lane` beside
        // `callId`). The bar's grouping reads it off the stored block, so the projector's
        // compaction signal survives only if this projection copies it — the same bug class as
        // the dropped `durationMs` this file exists for.
        expect(projectBlock(routeOf({ ...toolBlock, lane: 1 }))).toStrictEqual({
            kind: 'tool',
            id: '2-tool-7',
            turnId: 't1',
            sectionId: 't1:2',
            name: 'read',
            chars: 34,
            inPrompt: true,
            state: 'ok',
            at: T,
            endedAt: T + 800,
            durationMs: 800,
            argsChars: 23,
            resultChars: 11,
            eventFrom: 7,
            eventTo: 9,
            lane: 1
        });

        // Lane 0 is a PUBLISHED value, not an absence: the projector stamps `lane: 0` on
        // everything before the first compaction, and a truthiness check would silently drop
        // it (a 0 that becomes "no lane" is still 0 downstream, but it is no longer
        // distinguishable from a legacy record, which is what `lane: 0` + a later lane 1 is
        // exactly the case the lane tag rule keys off).
        expect(projectBlock(routeOf({ ...toolBlock, lane: 0 })).lane).toBe(0);
        expect('lane' in projectBlock(routeOf({ ...toolBlock, lane: 0 }))).toBe(true);

        // A record with no lane stays lane-less, and the key list is what proves nothing was
        // synthesized here: `contextBlockLaneOf` (./view-context.ts) supplies the 0 default at
        // read time, not the projection.
        const laneless = projectBlock(routeOf(promptBlock));

        expect('lane' in laneless).toBe(false);
        expect(Object.keys(projectBlock(routeOf({ ...toolBlock, lane: 2 }))).sort()).toContain('lane');
    });
});

describe('projectSection - the ONE bar is built from these segments', () => {
    it('keeps both segments in recorded order with every figure intact', () => {
        const wire: WireTurnSection = {
            id: 't1:2',
            role: 'primary',
            agent: 'demo',
            agentLabel: 'RR2',
            state: 'done',
            // The flow is empty here on purpose: the bar is the only thing under test, and a
            // section's `nodes`/`steps`/`context` are three separate wire lists.
            nodes: [],
            context: [routeOf(toolBlock), routeOf(reasoningBlock)]
        };

        const section = projectSection(wire);
        const context = section.context ?? [];

        expect(context.map((block) => block.id)).toEqual(['2-tool-7', '2-reasoning-3']);
        expect(context[0]).toStrictEqual({
            kind: 'tool',
            id: '2-tool-7',
            turnId: 't1',
            sectionId: 't1:2',
            name: 'read',
            chars: 34,
            inPrompt: true,
            state: 'ok',
            at: T,
            endedAt: T + 800,
            durationMs: 800,
            argsChars: 23,
            resultChars: 11,
            eventFrom: 7,
            eventTo: 9
        });
        expect(context[1]).toStrictEqual({
            kind: 'reasoning',
            id: '2-reasoning-3',
            turnId: 't1',
            sectionId: 't1:2',
            name: 'reasoning',
            chars: 284,
            inPrompt: false,
            at: T,
            endedAt: T + 1_500,
            durationMs: 1_500,
            eventFrom: 3,
            eventTo: 6
        });
    });
});
