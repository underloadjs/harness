// Direct tests for the TWO lazy detail surfaces the browser unwraps for a click (R2/R8).
//
// `stepDetailPayloadOf` (T5) turns a fetched `TurnStepDetail` — the verbatim recorded PAIR of
// one step — into the card's view data. `blockDetailPayloadOf` (T11) turns a fetched
// `TurnBlockDetail` — ONE context-bar segment plus its exact recorded bytes — into the
// dialog's view data. Neither is "compiling the transcript": the request already named one
// thing by id, the server answered exactly that thing, and the reader asked for it by CLICK.
// So every assertion here is about UNWRAPPING — no re-pairing (turn-display.ts:290-295), no
// synthesized answer for a call that never settled (turn-display.ts:580-583), and the two
// events carried VERBATIM so a details dialog can offer "copy the raw event" without a second
// request.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-detail.test.ts

import type { HarnessEvent } from '../types';
import type { ContextBlock, ContextBlockKind, TurnBlockDetail, TurnStepDetail } from '../shared/turn-display';
import { describe, expect, it } from 'vitest';
import { blockDetailPayloadOf, isBlockDetail, isStepDetail, stepDetailPayloadOf } from './view-detail';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// The recorded pair, spelled out
// ---------------------------------------------------------------------------

const callEvent = (args: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'instruct',
    call: { id: 'call-1', name: 'read', arguments: args }
});

const resultEvent = (overrides: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'tool_result',
        agent: 'instruct',
        callId: 'call-1',
        name: 'read',
        content: 'the whole file body',
        isError: false,
        outcome: 'completed',
        durationMs: 800,
        ...overrides
    }) as HarnessEvent;

const detail = (opening: HarnessEvent, result?: HarnessEvent, overrides: Partial<TurnStepDetail> = {}): TurnStepDetail => ({
    sessionId: 's1',
    turnId: 't1',
    stepId: '3',
    sectionId: 't1:0',
    opening: { index: 3, at: T, event: opening },
    ...(result === undefined ? {} : { result: { index: 6, at: T + 800, event: result } }),
    ...overrides
});

// ---------------------------------------------------------------------------
// The exact request AND response of one call
// ---------------------------------------------------------------------------

describe('stepDetailPayloadOf', () => {
    it('unwraps the recorded pair field for field, verbatim', () => {
        const opening = callEvent('{"path":"notes.md","max":20}');
        const settled = resultEvent({
            ui: [{ id: 'status', slot: 'scratch', title: 'Status', blocks: [{ type: 'text', text: 'open 2 · done 5' }] }],
            media: [{ id: 'm1', kind: 'image', name: 'plot.png', mime: 'image/png', size: 1200 }]
        });

        const payload = stepDetailPayloadOf(detail(opening, settled, { callId: 'call-1' }));

        expect(payload).toEqual({
            kind: 'tool',
            name: 'read',
            arguments: '{"path":"notes.md","max":20}',
            settled: true,
            result: 'the whole file body',
            outcome: 'completed',
            durationMs: 800,
            panels: [{ id: 'status', slot: 'scratch', title: 'Status', blocks: [{ type: 'text', text: 'open 2 · done 5' }] }],
            media: [{ id: 'm1', kind: 'image', name: 'plot.png', mime: 'image/png', size: 1200 }],
            openedAt: T,
            settledAt: T + 800,
            callId: 'call-1',
            opening,
            resultEvent: settled
        });
        // The events are the SAME objects the route answered with, not copies the client
        // reshaped: the dialog's raw copy must hand over what the server stored.
        expect(payload.opening).toBe(opening);
        expect(payload.resultEvent).toBe(settled);
    });

    it('prefers the authoritative outcome and falls back to the boolean projection', () => {
        const withOutcome = stepDetailPayloadOf(detail(callEvent('{}'), resultEvent({ outcome: 'cancelled', isError: true })));
        expect(withOutcome.outcome).toBe('cancelled');

        // An older recording has no `outcome`; `isError` is its projection (the same
        // precedence the compact row was painted with, so the two can only agree).
        const legacy = stepDetailPayloadOf(detail(callEvent('{}'), resultEvent({ outcome: undefined, isError: true })));
        expect(legacy.outcome).toBe('failed');

        const clean = stepDetailPayloadOf(detail(callEvent('{}'), resultEvent({ outcome: undefined, isError: false })));
        expect(clean.outcome).toBe('completed');
    });

    it('reports a call that has not settled as unsettled, never with a synthesized answer', () => {
        const opening = callEvent('{"path":"x"}');

        expect(stepDetailPayloadOf(detail(opening))).toEqual({
            kind: 'tool',
            name: 'read',
            arguments: '{"path":"x"}',
            settled: false,
            opening,
            openedAt: T,
            callId: undefined,
            result: undefined,
            outcome: undefined,
            durationMs: undefined,
            panels: undefined,
            media: undefined,
            settledAt: undefined
        });
    });

    it('takes the content of a result-only recording from the opening event itself', () => {
        // A protocol that reports results without calls, or a missed `tool_call`
        // (../server/turn-projector.ts:1159): `DisplayStep.detail.stepId` IS this
        // result's own index, so the route answers with the result as the opening and no
        // second event. Reading the fields off the opening is an unwrap, not a re-pair.
        const settled = resultEvent({ isError: false, outcome: undefined, ui: [{ id: 'live', slot: 'scratch', title: 'Live', blocks: [{ type: 'text', text: 'running now' }] }] });

        const payload = stepDetailPayloadOf(detail(settled));

        expect(payload.kind).toBe('tool');
        expect(payload.name).toBe('read');
        expect(payload.settled).toBe(true);
        expect(payload.result).toBe('the whole file body');
        expect(payload.outcome).toBe('completed');
        expect(payload.durationMs).toBe(800);
        expect(payload.panels).toEqual([{ id: 'live', slot: 'scratch', title: 'Live', blocks: [{ type: 'text', text: 'running now' }] }]);
        // The one timestamp the route echoed is the opening's, and it is also when the
        // call finished: there is no second event to invent a span from.
        expect(payload.openedAt).toBe(T);
        expect(payload.settledAt).toBe(T);
        expect(payload.resultEvent).toBeUndefined();
    });

    it('carries an owner question and its recorded answer', () => {
        const request: HarnessEvent = {
            type: 'action_request',
            agent: 'instruct',
            request: {
                requestId: 'req-1',
                question: 'Push the branch?',
                recommended: 'yes',
                options: [
                    { id: 'yes', label: 'Push' },
                    { id: 'no', label: 'Leave it' }
                ],
                allowCustom: true
            }
        };
        const answer: HarnessEvent = {
            type: 'action_answer',
            agent: 'instruct',
            requestId: 'req-1',
            answer: { requestId: 'req-1', choice: { kind: 'option', optionId: 'yes' }, source: 'owner' }
        };

        const payload = stepDetailPayloadOf(detail(request, answer, { stepId: '9', sectionId: 't1:1' }));

        expect(payload.kind).toBe('action');
        expect(payload.name).toBe('Push the branch?');
        expect(payload.request).toBe((request as Extract<HarnessEvent, { type: 'action_request' }>).request);
        expect(payload.answer).toEqual({ requestId: 'req-1', choice: { kind: 'option', optionId: 'yes' }, source: 'owner' });
        expect(payload.settled).toBe(true);
        expect(payload.result).toBeUndefined();
        expect(payload.panels).toBeUndefined();
    });

    it('stays total for a frame that is not a step opener', () => {
        // A malformed or unexpected answer must not throw inside an open dialog.
        const odd = { type: 'text', agent: 'instruct', delta: 'not a call' } as HarnessEvent;

        expect(stepDetailPayloadOf(detail(odd))).toEqual({
            kind: 'tool',
            name: '',
            arguments: '',
            settled: false,
            opening: odd,
            openedAt: T
        });
    });

    it('keeps an absent arguments field as the empty string the model effectively sent', () => {
        const bare = { type: 'tool_call', agent: 'instruct', call: { id: 'c', name: 'ping' } } as unknown as HarnessEvent;

        expect(stepDetailPayloadOf(detail(bare)).arguments).toBe('');
    });

    it('refuses a duration the record never measured', () => {
        const payload = stepDetailPayloadOf(detail(callEvent('{}'), resultEvent({ durationMs: undefined })));

        expect(payload.durationMs).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// The body guard: a 200 is not proof of the contract
// ---------------------------------------------------------------------------

describe('isStepDetail', () => {
    it('accepts only an answer that carries a step id and an opening event', () => {
        expect(isStepDetail(detail(callEvent('{}'), resultEvent()))).toBe(true);

        const noOpening = { ...detail(callEvent('{}')), opening: undefined } as unknown as TurnStepDetail;
        expect(isStepDetail(noOpening)).toBe(false);
        expect(isStepDetail({ ...detail(callEvent('{}')), opening: { index: 1 } } as unknown as TurnStepDetail)).toBe(false);
        expect(isStepDetail({ ...detail(callEvent('{}')), stepId: 3 } as unknown as TurnStepDetail)).toBe(false);
        expect(isStepDetail(null)).toBe(false);
        expect(isStepDetail('detail')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// T11: ONE context-bar segment answered exactly (R8)
// ---------------------------------------------------------------------------
//
// The block route is the SECOND lazy surface, and the same rules apply: the server already
// concatenated `eventFrom..eventTo`, already split a tool into its recorded halves, already
// echoed the metadata the segment shows. This is an unwrap, so the assertions are about what
// stays ABSENT (a byte the record never held) and about the metadata travelling WITH the
// answer instead of being re-read from the bar.

describe('blockDetailPayloadOf', () => {
    const meta = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
        kind: 'tool',
        id: '0-tool-7',
        turnId: 't1',
        sectionId: 't1:0',
        name: 'read',
        chars: 46,
        argsChars: 20,
        resultChars: 26,
        inPrompt: true,
        state: 'ok',
        eventFrom: 7,
        eventTo: 9,
        at: T,
        endedAt: T + 800,
        ...overrides
    });

    it('unwraps a settled tool into both recorded halves, verbatim', () => {
        const detail: TurnBlockDetail = {
            ...meta(),
            sessionId: 's1',
            args: '{"path":"notes.md","max":20}',
            result: 'the whole recorded file body'
        };

        expect(blockDetailPayloadOf(detail)).toEqual({
            kind: 'tool',
            name: 'read',
            block: detail,
            sessionId: 's1',
            turnId: 't1',
            blockId: '0-tool-7',
            args: '{"path":"notes.md","max":20}',
            result: 'the whole recorded file body',
            settled: true,
            durationMs: 800,
            detailChars: 56
        });
        // The metadata the dialog prints its header from IS the route answer, by reference.
        expect(blockDetailPayloadOf(detail).block).toBe(detail);
    });

    it('reports a running call as unsettled, with only the arguments it holds', () => {
        const detail: TurnBlockDetail = {
            ...meta({ state: 'running', chars: 28, resultChars: undefined, endedAt: undefined, eventTo: 7 }),
            sessionId: 's1',
            args: '{"path":"notes.md","max":20}'
        };
        const payload = blockDetailPayloadOf(detail);

        expect(payload.settled).toBe(false);
        expect(payload.result).toBeUndefined();
        expect(payload.durationMs).toBeUndefined();
        expect(payload.detailChars).toBe(28);
    });

    it('carries prose as one exact text, for prompt, answer and thinking alike', () => {
        const prose = (kind: ContextBlockKind, text: string): TurnBlockDetail => ({
            ...meta({ kind, id: `0-${kind}-1`, name: kind, chars: text.length, argsChars: undefined, resultChars: undefined, state: undefined }),
            sessionId: 's1',
            text
        });

        expect(blockDetailPayloadOf(prose('user', 'read the notes'))).toMatchObject({
            kind: 'user',
            text: 'read the notes',
            settled: true,
            detailChars: 14
        });
        expect(blockDetailPayloadOf(prose('assistant', 'the answer'))).toMatchObject({ kind: 'assistant', text: 'the answer', detailChars: 10 });
        expect(blockDetailPayloadOf(prose('reasoning', 'thinking'))).toMatchObject({ kind: 'reasoning', text: 'thinking', detailChars: 8 });
    });

    it('keeps the instruction entries as separate exact strings', () => {
        const entries = ['Answer directly.', 'Use the tools you have.'];
        const detail: TurnBlockDetail = {
            ...meta({ kind: 'system', id: '0-system-instructions', name: 'instructions', chars: 39, argsChars: undefined, resultChars: undefined, state: undefined, eventFrom: undefined, eventTo: undefined }),
            sessionId: 's1',
            entries
        };
        const payload = blockDetailPayloadOf(detail);

        expect(payload.entries).toEqual(entries);
        expect(payload.settled).toBe(true);
        // Sum of the entries, never the join the transport applies between messages.
        expect(payload.detailChars).toBe(39);
    });

    it('leaves a byte the record does not hold absent instead of inventing one', () => {
        // A malformed or unexpected body still answers, so an open dialog cannot throw.
        const odd = { ...meta(), sessionId: 's1', args: null, result: 7, text: {} } as unknown as TurnBlockDetail;
        const payload = blockDetailPayloadOf(odd);

        expect(payload.args).toBeUndefined();
        expect(payload.result).toBeUndefined();
        expect(payload.text).toBeUndefined();
        expect(payload.detailChars).toBe(0);
        expect(payload.settled).toBe(true);
    });

    it('filters a non-string entry out of an instruction set instead of stringifying it', () => {
        const detail = {
            ...meta({ kind: 'system', chars: 16, argsChars: undefined, resultChars: undefined, state: undefined }),
            sessionId: 's1',
            entries: ['Answer directly.', null, 7]
        } as unknown as TurnBlockDetail;

        expect(blockDetailPayloadOf(detail).entries).toEqual(['Answer directly.']);
    });

    it('prefers the measured span and refuses to invent one', () => {
        const measured = blockDetailPayloadOf({ ...meta(), sessionId: 's1', durationMs: 900 } as TurnBlockDetail);
        expect(measured.durationMs).toBe(900);

        const unmeasured = blockDetailPayloadOf({ ...meta({ endedAt: undefined }), sessionId: 's1' });
        expect(unmeasured.durationMs).toBeUndefined();
    });
});

describe('isBlockDetail', () => {
    it('accepts only a body that carries the address and a known kind', () => {
        const meta: ContextBlock = {
            kind: 'tool',
            id: '0-tool-7',
            turnId: 't1',
            sectionId: 't1:0',
            name: 'read',
            chars: 46,
            inPrompt: true
        };

        expect(isBlockDetail({ ...meta, sessionId: 's1', args: '{}', result: 'body' })).toBe(true);
        expect(isBlockDetail({ ...meta, kind: 'reasoning', sessionId: 's1', text: 'thoughts' })).toBe(true);
        expect(isBlockDetail({ ...meta, kind: 'made-up' } as unknown as TurnBlockDetail)).toBe(false);
        expect(isBlockDetail({ ...meta, id: 7 } as unknown as TurnBlockDetail)).toBe(false);
        expect(isBlockDetail({ ...meta, chars: '46' } as unknown as TurnBlockDetail)).toBe(false);
        expect(isBlockDetail({ sessionId: 's1' })).toBe(false);
        expect(isBlockDetail(null)).toBe(false);
        expect(isBlockDetail('block')).toBe(false);
    });
});
