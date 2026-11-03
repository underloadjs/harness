// The ONE place the browser turns a fetched `TurnStepDetail` into view data (R2).
//
// `TurnStepDetail` (src/shared/turn-display.ts:554) is the verbatim recorded PAIR:
// the event that opened a step and the event that settled it. Reading those two
// events is not "compiling the transcript" — the request already named one step by
// id, the server returned exactly that step, and the user asked for it by CLICK.
// Everything else in the browser stays event-free, which is why this mapper lives in
// its own module: a reader can prove the default path never touches it, because
// nothing else imports it.
//
// Rules:
//   - NO re-pairing and NO re-derivation: the server paired `callId` within the
//     opening event's own invocation (turn-display.ts:297), so this module only
//     unwraps fields that already exist.
//   - Missing pieces stay missing (`settled: false`, no `result`), never a
//     synthesized answer.
//   - Durations prefer the server's measured `durationMs` (types/index.ts:1845) and
//     fall back to nothing at all — the same "never invent a span" rule ui/tools.ts
//     applies to a legacy record.
//   - The two events are carried VERBATIM (`opening`/`resultEvent`) so a details
//     dialog can offer "copy the raw event" without a second request.
//
// Cross-references:
//   - ./view-api.ts `getStepDetail`  — the route (GET /views/:id/turns/:t/steps/:s)
//   - ./ui/turns.ts                  — the only caller (a tool chip's expand)
//   - ./ui/tools.ts                  — the card that paints this payload
//   - ./contract.ts                  — the field accessors reused here

import type { HarnessEvent, HarnessToolOutcome, HarnessActionRequest, HarnessActionAnswer, ToolMediaDescriptor, ToolUiPanel } from '../types';
import type { TurnStepDetail } from '../shared/turn-display';
import { actionAnswerEventOf, toolDurationOf } from './contract';

export type StepDetailPayload = {
    /** Which kind of step this is, from the OPENING event, not from a name. */
    kind: 'tool' | 'action';
    /** Tool name (or the action's question title) — display only. */
    name: string;
    /**
     * The raw `tool_call.arguments` JSON string exactly as the model sent it
     * (types/index.ts:100). Empty string when the opening event carries none.
     */
    arguments: string;
    /** False when the recorded turn has no settled event for this step. */
    settled: boolean;
    /** The full `tool_result.content`, present only when the call settled. */
    result?: string;
    /** Authoritative classification; absent only on a pre-`outcome` recording. */
    outcome?: HarnessToolOutcome;
    /** Server-measured span; absent = never measured (never a local guess here). */
    durationMs?: number;
    /** Every `ToolUiPanel` the result contributed — FULL cells/rows (detail-only). */
    panels?: ToolUiPanel[];
    /** Every media descriptor the result contributed (never base64). */
    media?: ToolMediaDescriptor[];
    /** Kind `action` only: the recorded question. */
    request?: HarnessActionRequest;
    /** Kind `action` only: the recorded answer, once there is one. */
    answer?: HarnessActionAnswer;
    /** `eventTimes` entries the server echoed with the pair. */
    openedAt?: number;
    settledAt?: number;
    /** The step's tool-call identity, when both events carry one. */
    callId?: string;
    /** The verbatim events, for the dialog's raw copy. */
    opening: HarnessEvent;
    resultEvent?: HarnessEvent;
};

// The tool name of an opening event: `tool_call.call.name`, or the action's question
// title (mirroring how `DisplayStep.name` is described at turn-display.ts:321).
const nameOfOpening = (event: HarnessEvent): string => {
    if (event.type === 'tool_call') return event.call.name;
    if (event.type === 'action_request') return event.request.question;

    return '';
};

// Unwrap one fetched step detail. Total: a detail whose opening event is not a step
// opener (a malformed or unexpected frame) still yields a payload — with empty
// arguments and `settled: false` — rather than throwing inside an open dialog.
export const stepDetailPayloadOf = (detail: TurnStepDetail): StepDetailPayload => {
    const opening = detail.opening.event;
    const resultEvent = detail.result?.event;

    const payload: StepDetailPayload = {
        kind: opening.type === 'action_request' ? 'action' : 'tool',
        name: nameOfOpening(opening),
        arguments: opening.type === 'tool_call' ? (opening.call.arguments ?? '') : '',
        settled: resultEvent !== undefined,
        opening,
        ...(detail.opening.at === undefined ? {} : { openedAt: detail.opening.at }),
        ...(detail.callId === undefined ? {} : { callId: detail.callId })
    };

    if (opening.type === 'action_request') payload.request = opening.request;

    if (resultEvent === undefined) return payload;

    const at = detail.result?.at;
    if (at !== undefined) payload.settledAt = at;

    if (resultEvent.type === 'tool_result') {
        payload.result = resultEvent.content;
        // R1: `outcome` is authoritative when present; `isError` is its boolean
        // projection on an older recording (the same rule ui/turns.ts:5125 applies).
        payload.outcome = resultEvent.outcome ?? (resultEvent.isError ? 'failed' : 'completed');

        const duration = toolDurationOf(resultEvent);
        if (duration !== undefined) payload.durationMs = duration;

        if (Array.isArray(resultEvent.ui)) payload.panels = resultEvent.ui;
        if (Array.isArray(resultEvent.media)) payload.media = resultEvent.media;

        return payload;
    }

    if (resultEvent.type === 'action_answer') {
        const frame = actionAnswerEventOf(resultEvent);
        if (frame !== undefined) payload.answer = frame.answer;
    }

    return payload;
};

// Guard for a fetched body: the route's answer is `{ detail }`, and a proxy that
// answers 200 with something else must not make the renderer read `.opening.event`
// blindly (the same "a 200 is not proof of the contract" rule api.ts applies to
// every JSON answer).
export const isStepDetail = (value: unknown): value is TurnStepDetail =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as TurnStepDetail).stepId === 'string' &&
    (value as TurnStepDetail).opening !== null &&
    typeof (value as TurnStepDetail).opening === 'object' &&
    (value as TurnStepDetail).opening.event !== null &&
    typeof (value as TurnStepDetail).opening.event === 'object';
